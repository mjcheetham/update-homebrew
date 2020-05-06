import * as core from '@actions/core';
import { Tap, Package } from './homebrew';
import { Commit, PullRequest } from './git';
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
    const versionStr = core.getInput('version', { required: true });
    let sha256 = core.getInput('sha256');
    const url = core.getInput('url');
    const message = core.getInput('message');
    const type = core.getInput('type').toLowerCase();

    core.debug(`tap=${tapStr}`);
    core.debug(`name=${name}`);
    core.debug(`version=${versionStr}`);
    core.debug(`sha256=${sha256}`);
    core.debug(`url=${url}`);
    core.debug(`message=${message}`);
    core.debug(`type=${type}`);

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

    const version = new Version(versionStr);

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
      throw new Error('must specify the SHA256 checksum if URL is omitted');
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
