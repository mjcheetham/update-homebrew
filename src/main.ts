import * as core from '@actions/core';
import { Tap, Package } from './homebrew';
import { Repository, Commit, PullRequest } from './git';
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
    let sha256 = core.getInput('sha256');
    const url = core.getInput('url');
    const message = core.getInput('message');
    const type = core.getInput('type').toLowerCase();
    const releaseRepo =
      core.getInput('releaseRepo') ?? process.env.GITHUB_REPOSITORY;
    const releaseTag = core.getInput('releaseTag') ?? process.env.GITHUB_REF;
    const releaseAsset = core.getInput('releaseAsset');

    core.debug(`tap=${tapStr}`);
    core.debug(`name=${name}`);
    core.debug(`version=${versionStr}`);
    core.debug(`sha256=${sha256}`);
    core.debug(`url=${url}`);
    core.debug(`message=${message}`);
    core.debug(`type=${type}`);
    core.debug(`releaseRepo=${releaseRepo}`);
    core.debug(`releaseTag=${releaseTag}`);
    core.debug(`releaseAsset=${releaseAsset}`);

    if (!versionStr && !releaseAsset) {
      throw new Error(
        "must specify either the 'version' parameter OR 'releaseAsset' parameters."
      );
    }

    if (versionStr && releaseAsset) {
      core.warning(
        "'version' parameter specified as well as 'releaseAsset' parameter; using 'version' parameter only"
      );
    }

    let version: Version;

    if (versionStr) {
      core.debug(
        `using 'version' parameter for new package version: ${versionStr}`
      );
      version = new Version(versionStr);
    } else {
      core.debug(
        `computing new package version number from asset in repo '${releaseRepo}' @ '${releaseTag}'`
      );
      const repoName = Repository.splitRepoName(releaseRepo);
      const sourceRepo = await Repository.createAsync(
        gitHub,
        repoName.owner,
        repoName.repoName
      );
      const assets = await sourceRepo.getReleaseAssetsAsync(releaseTag);
      const nameRegex = new RegExp(releaseAsset);
      const asset = assets.find(x => nameRegex.test(x.name));
      if (!asset) {
        throw new Error(
          `unable to find an asset matching '${releaseAsset}' in repo '${releaseRepo}'`
        );
      }
      const matches = asset.name.match(nameRegex);
      if (!matches || matches.length < 2) {
        throw new Error(
          `unable to match at least one capture group in asset name '${asset.name}' with regular expression '${nameRegex}'`
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

      if (sha256) {
        core.debug(
          'skipping SHA256 computation from asset as it has already been specified'
        );
      } else if (url) {
        core.debug(
          'skipping SHA256 computation from asset as a URL has been specified'
        );
      } else {
        core.debug(
          `computing SHA256 hash of data from asset at '${asset.downloadUrl}'...`
        );
        sha256 = await computeSha256Async(asset.downloadUrl);
        core.debug(`sha256=${sha256}`);
      }
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

    if (url) {
      const fullUrl = version.format(url);
      core.debug('updating url...');
      pkg.setField('url', fullUrl);

      if (!sha256) {
        core.debug(`computing SHA256 hash of data from '${fullUrl}'...`);
        sha256 = await computeSha256Async(fullUrl);
        core.debug(`sha256=${sha256}`);
      }
    } else if (!sha256) {
      throw new Error(
        'must specify the SHA256 checksum or a release asset if the URL is omitted'
      );
    }

    core.debug('updating sha256...');
    pkg.setField('sha256', sha256);

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
    const result = await tap.updatePackageAsync(pkg, fullMessage);
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
