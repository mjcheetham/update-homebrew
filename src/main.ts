import * as core from '@actions/core';
import { Tap, Package } from './homebrew';
import { Repository, Commit, PullRequest, ReleaseAsset } from './git';
import { Version } from './version';
import { GitHub } from '@actions/github';
import { computeSha256Async } from './hash';

function formatMessage(
  format: string,
  name: string,
  filePath: string,
  packageType: string,
  version: Version
): string {
  return version
    .format(format)
    .replace(/{{name}}/g, name)
    .replace(/{{file}}/g, filePath)
    .replace(/{{type}}/g, packageType);
}

async function run(): Promise<void> {
  try {
    const token = core.getInput('token');
    const gitHub = new GitHub(token);

    const tapStr = core.getInput('tap', { required: true });
    const tapBranch = core.getInput('branch');
    const tap = await Tap.createAsync(gitHub, tapStr, tapBranch);

    const name = core.getInput('name', { required: true });
    const versionStr = core.getInput('version');
    const sha256 = core.getInput('sha256');
    const url = core.getInput('url');
    const message = core.getInput('message');
    const type = core.getInput('type').toLowerCase();
    const releaseRepo =
      core.getInput('releaseRepo') || process.env.GITHUB_REPOSITORY!;
    const releaseTag = core.getInput('releaseTag') || process.env.GITHUB_REF!;
    const releaseAsset = core.getMultilineInput('releaseAsset');
    const alwaysUsePullRequest =
      core.getInput('alwaysUsePullRequest') === 'true';

    core.debug(`tap=${tapStr}`);
    core.debug(`name=${name}`);
    core.debug(`version=${versionStr}`);
    core.debug(`sha256=${sha256}`);
    core.debug(`url=${url}`);
    core.debug(`message=${message}`);
    core.debug(`type=${type}`);
    core.debug(`releaseRepo=${releaseRepo}`);
    core.debug(`releaseTag=${releaseTag}`);
    core.debug(
      `releaseAsset contains ${releaseAsset.length} assets with names:`
    );
    for (const ra of releaseAsset) {
      core.debug(`${ra}`);
    }
    core.debug(`alwaysUsePullRequest=${alwaysUsePullRequest}`);

    core.debug(
      `process.env.GITHUB_REPOSITORY=${process.env.GITHUB_REPOSITORY}`
    );
    core.debug(`process.env.GITHUB_REF=${process.env.GITHUB_REF}`);

    if (!versionStr && releaseAsset.length === 0) {
      throw new Error(
        "must specify either the 'version' parameter OR 'releaseAsset' parameter."
      );
    }

    if (versionStr && releaseAsset.length > 0) {
      core.warning(
        "'version' parameter specified as well as 'releaseAsset' parameter; using 'version' parameter only"
      );
    }

    let version: Version;
    const repoName = Repository.splitRepoName(releaseRepo);
    const sourceRepo = await Repository.createAsync(
      gitHub,
      repoName.owner,
      repoName.repoName
    );

    let assets: ReleaseAsset[];
    const nameRegExesAndAssets: Map<RegExp, ReleaseAsset> = new Map<
      RegExp,
      ReleaseAsset
    >();
    let nameRegEx = new RegExp('');
    let asset = new ReleaseAsset('', '', '');
    const sha256Hashes = new Map<string, string>();

    if (versionStr) {
      core.debug(
        `using 'version' parameter for new package version: ${versionStr}`
      );
      version = new Version(versionStr);
    } else {
      assets = await sourceRepo.getReleaseAssetsAsync(releaseTag);
      // match downloaded release asset(s) to name regex(es)
      for (const ra of releaseAsset) {
        nameRegEx = new RegExp(ra);
        // assume each specified name regex corresponds to exactly one release asset
        asset = assets.find(x => nameRegEx.test(x.name))!;
        nameRegExesAndAssets.set(nameRegEx, asset);
      }

      if (nameRegExesAndAssets.size === 0) {
        let msg =
          `unable to find an asset in '${releaseRepo}' matching specified regex(es).\n` +
          `regex(es) checked:\n`;
        for (const re of releaseAsset) {
          msg += `${re}\n`;
        }
        throw new Error(msg);
      }

      core.debug(
        `computing new package version number from asset in repo '${releaseRepo}' @ '${releaseTag}'\n` +
          `asset found using first releaseAsset regex`
      );

      const matches = asset.name.match(nameRegEx);
      if (!matches || matches.length < 2) {
        throw new Error(
          `unable to match at least one capture group in asset name '${asset.name}' with regular expression '${nameRegEx}'`
        );
      }
      if (matches.groups?.version) {
        core.debug(
          `using 'version' named capture group for new package version: ${matches.groups?.version}`
        );
        version = new Version(matches.groups.version);
      } else {
        core.debug(
          `using first capture group for new package version: ${matches[1]}`
        );
        version = new Version(matches[1]);
      }
    }

    // single asset with precomputed hash
    if (nameRegExesAndAssets.size <= 1 && sha256) {
      sha256Hashes.set(asset.name, sha256);
      core.debug(
        'skipping SHA256 computation from asset since already specified'
      );
      // single asset with URL
    } else if (nameRegExesAndAssets.size <= 1 && url) {
      const fullUrl = version.format(url);
      core.debug(`computing SHA256 hash of data from '${fullUrl}'...`);
      sha256Hashes.set(asset.name, await computeSha256Async(fullUrl));
      // multiple assets or single asset without hash or URL
    } else if (nameRegExesAndAssets.size >= 1) {
      core.debug(
        `computing hash(es) for ${nameRegExesAndAssets.size} asset(s)`
      );
      for (const ra of nameRegExesAndAssets.values()) {
        core.debug(
          `computing SHA256 hash of data from asset at '${ra.downloadUrl}'...`
        );
        sha256Hashes.set(ra.name, await computeSha256Async(ra.downloadUrl));
      }
    }
    if (sha256Hashes.size === 0) {
      throw new Error(
        'cannot find/calculate SHA256 checksum. please try one of the following:\n' +
          '1. Specify a release asset and SHA256\n' +
          '2. Specify a release asset and URL\n' +
          '3. Specify one or more release assets'
      );
    }

    core.debug('getting package...');
    let pkg: Package;
    switch (type) {
      case 'formula': {
        pkg = await tap.getFormulaAsync(name);
        break;
      }

      case 'cask': {
        pkg = await tap.getCaskAsync(name);
        break;
      }

      default:
        throw new Error(`unknown type '${type}'`);
    }

    core.debug('updating sha256...');
    let counter = 0;
    for (const a of sha256Hashes.keys()) {
      pkg.setField('sha256', sha256Hashes.get(a)!, counter);
      ++counter;
    }

    core.debug('updating version...');
    pkg.setField('version', version.toString());

    const fullMessage = formatMessage(
      message,
      name,
      pkg.filePath,
      type,
      version
    );

    if (!pkg.isDirty()) {
      core.warning('no changes were made to the package file');
      return;
    }

    core.debug('publishing updated package...');
    const updateOptions = {
      package: pkg,
      message: fullMessage,
      alwaysUsePullRequest
    };
    const result = await tap.updatePackageAsync(updateOptions);
    if (result instanceof Commit) {
      core.info(`Created commit '${result.sha}': ${result.url}`);
    } else if (result instanceof PullRequest) {
      core.info(`Created pull request '${result.id}': ${result.url}`);
    } else {
      core.warning('unknown type of package update');
    }
  } catch (error) {
    core.setFailed(error.message);
  }
}

run();
