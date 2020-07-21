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
    pkg: Package,
    message: string,
    forkOwner?: string
  ): Promise<Git.Commit | Git.PullRequest> {
    let commitRepo: Git.Repository;
    let commitBranch: Git.Branch;
    let createPull: boolean;

    if (this.repo.canPush) {
      if (!this.branch.isProtected) {
        // Commit directly to the branch in this repo
        commitRepo = this.repo;
        commitBranch = this.branch;
        createPull = false;
      } else {
        // Need to update via a PR in this repo
        commitRepo = this.repo;
        commitBranch = await this.repo.createBranchAsync(
          `update-${Date.now().toString()}`,
          this.branch.sha
        );
        createPull = true;
      }
    } else {
      // Need to update via PR from a fork
      const fork = await this.repo.createForkAsync(forkOwner);
      commitRepo = fork;
      commitBranch = fork.defaultBranch;
      createPull = true;
    }

    // Create the commit
    const commit = await this.repo.commitFileAsync(
      commitBranch.name,
      pkg.filePath,
      pkg.content,
      message,
      pkg.gitBlob
    );

    if (!createPull) {
      return commit;
    }

    let pullTitle: string;
    let pullBody: string;
    const msgParts = message.split('\n');

    if (msgParts.length === 1) {
      pullTitle = message;
      pullBody = '';
    } else if (msgParts.length > 1) {
      pullTitle = msgParts[0];
      pullBody = msgParts.slice(1).join('\n');
    } else {
      pullTitle = `Update ${pkg.filePath}`;
      pullBody = '';
    }

    return await this.repo.createPullRequestAsync(
      this.branch.name,
      commitBranch.name,
      pullTitle,
      pullBody,
      commitRepo.owner
    );
  }
}
