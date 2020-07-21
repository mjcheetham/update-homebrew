import * as core from '@actions/core';
import { GitHub } from '@actions/github';
import * as Git from './git';

export class Package {
  readonly filePath: string;
  readonly originalContent: string;
  readonly gitBlob: string | undefined;
  content: string;

  /* eslint-disable no-dupe-class-members */
  constructor(gitFile: Git.File);
  constructor(filePath: string, content: string);
  constructor(pathOrGitFile: string | Git.File, content?: string) {
    if (pathOrGitFile instanceof Git.File) {
      this.filePath = pathOrGitFile.path;
      this.gitBlob = pathOrGitFile.blob;
      this.content = pathOrGitFile.content;
    } else {
      this.filePath = pathOrGitFile;
      this.content = content || '';
    }

    this.originalContent = this.content;
  }
  /* eslint-enable no-dupe-class-members */

  isDirty(): boolean {
    return this.originalContent !== this.content;
  }

  private getFieldRegex(name: string): RegExp {
    return new RegExp(`^(\\s*)${name} +(['"])([^'"]+)\\2`, 'm');
  }

  getField(name: string): string {
    const match = this.content.match(this.getFieldRegex(name));
    return match ? match[3] : '';
  }

  setField(name: string, value: string): void {
    this.content = this.content.replace(
      this.getFieldRegex(name),
      (line, indent, quote) => {
        return `${indent}${name} ${quote}${value}${quote}`;
      }
    );
  }
}

export interface UpdatePackageOptions {
  package: Package;
  message: string;
  forkOwner?: string;
  alwaysUsePullRequest: boolean;
}

export class Tap {
  private repo: Git.Repository;
  private branch: Git.Branch;

  private constructor(repo: Git.Repository, branch: Git.Branch) {
    this.repo = repo;
    this.branch = branch;
  }

  static async createAsync(
    api: GitHub,
    name: string,
    branch?: string
  ): Promise<Tap> {
    const nameParts = Git.Repository.splitRepoName(name);

    const tapOwner = nameParts.owner;
    let tapRepoName = nameParts.repoName;
    if (!tapRepoName.startsWith('homebrew-')) {
      tapRepoName = `homebrew-${tapRepoName}`;
    }

    const repo = await Git.Repository.createAsync(api, tapOwner, tapRepoName);
    const tapBranch = branch
      ? await repo.getBranchAsync(branch)
      : repo.defaultBranch;

    return new Tap(repo, tapBranch);
  }

  async getPackageAsync(filePath: string): Promise<Package> {
    const file = await this.repo.getFileAsync(filePath, this.branch?.name);
    return new Package(file);
  }

  async getFormulaAsync(name: string): Promise<Package> {
    const filePath = `Formula/${name}.rb`;
    return this.getPackageAsync(filePath);
  }

  async getCaskAsync(name: string): Promise<Package> {
    const filePath = `Casks/${name}.rb`;
    return this.getPackageAsync(filePath);
  }

  async updatePackageAsync(
    options: UpdatePackageOptions
  ): Promise<Git.Commit | Git.PullRequest> {
    let commitRepo: Git.Repository;
    let commitBranch: Git.Branch;
    let createPull: boolean;

    core.debug(
      `canPush=${this.repo.canPush}, isProtected=${this.branch.isProtected}, alwaysUsePullRequest=${options.alwaysUsePullRequest}`
    );

    if (
      this.repo.canPush &&
      (this.branch.isProtected || options.alwaysUsePullRequest)
    ) {
      core.debug('updating via PR in tap repo');
      // Need to update via a PR in this repo
      commitRepo = this.repo;
      commitBranch = await this.repo.createBranchAsync(
        `update-${Date.now().toString()}`,
        this.branch.sha
      );
      createPull = true;
    } else if (
      this.repo.canPush &&
      !this.branch.isProtected &&
      !options.alwaysUsePullRequest
    ) {
      core.debug('updating via commit in tap repo');
      // Commit directly to the branch in this repo
      commitRepo = this.repo;
      commitBranch = this.branch;
      createPull = false;
    } else {
      core.debug('updating via PR in fork tap');
      // Need to update via PR from a fork
      const fork = await this.repo.createForkAsync(options.forkOwner);
      commitRepo = fork;
      commitBranch = fork.defaultBranch;
      createPull = true;
    }

    // Create the commit
    core.debug('creating commit...');
    const commit = await this.repo.commitFileAsync(
      commitBranch.name,
      options.package.filePath,
      options.package.content,
      options.message,
      options.package.gitBlob
    );

    if (!createPull) {
      return commit;
    }

    core.debug('generating pull request message...');
    let pullTitle: string;
    let pullBody: string;
    const msgParts = options.message.split('\n');

    if (msgParts.length === 1) {
      pullTitle = options.message;
      pullBody = '';
    } else if (msgParts.length > 1) {
      pullTitle = msgParts[0];
      pullBody = msgParts.slice(1).join('\n');
    } else {
      pullTitle = `Update ${options.package.filePath}`;
      pullBody = '';
    }

    core.debug(`PR message is: ${pullTitle}\n${pullBody}`);

    core.debug('creating pull request...');
    return await this.repo.createPullRequestAsync(
      this.branch.name,
      commitBranch.name,
      pullTitle,
      pullBody,
      commitRepo.owner
    );
  }
}
