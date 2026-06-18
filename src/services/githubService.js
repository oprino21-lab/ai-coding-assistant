const { Octokit } = require('octokit');
const simpleGit = require('simple-git');
const fs = require('fs-extra');
const path = require('path');
const logger = require('../utils/logger');

const REPOS_DIR = path.join(process.cwd(), 'repos');

async function getOctokit(accessToken) {
  return new Octokit({ auth: accessToken });
}

async function listUserRepos(accessToken) {
  const octokit = await getOctokit(accessToken);
  const { data } = await octokit.rest.repos.listForAuthenticatedUser({
    sort: 'updated',
    per_page: 50,
    visibility: 'all'
  });
  return data.map(r => ({
    id: r.id,
    name: r.name,
    fullName: r.full_name,
    description: r.description,
    private: r.private,
    language: r.language,
    updatedAt: r.updated_at,
    defaultBranch: r.default_branch,
    cloneUrl: r.clone_url,
    htmlUrl: r.html_url
  }));
}

async function cloneOrUpdateRepo(accessToken, username, repoFullName) {
  await fs.ensureDir(REPOS_DIR);
  const localPath = path.join(REPOS_DIR, username, repoFullName.replace('/', '_'));
  await fs.ensureDir(path.dirname(localPath));

  const cloneUrl = `https://${accessToken}@github.com/${repoFullName}.git`;

  if (await fs.pathExists(path.join(localPath, '.git'))) {
    logger.info(`Updating existing repo: ${repoFullName}`);
    const git = simpleGit(localPath);
    await git.pull();
  } else {
    logger.info(`Cloning repo: ${repoFullName}`);
    await simpleGit().clone(cloneUrl, localPath);
  }

  return localPath;
}

async function getRepoFileTree(localPath, maxFiles = 500) {
  const { glob } = require('glob');
  const ignorePatterns = [
    '**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**',
    '**/*.min.js', '**/*.min.css', '**/package-lock.json', '**/yarn.lock',
    '**/*.jpg', '**/*.jpeg', '**/*.png', '**/*.gif', '**/*.svg',
    '**/*.ico', '**/*.woff', '**/*.woff2', '**/*.ttf', '**/*.eot',
    '**/*.zip', '**/*.tar', '**/*.gz', '**/__pycache__/**', '**/*.pyc',
    '**/venv/**', '**/.env', '**/*.lock'
  ];

  const files = await glob('**/*', {
    cwd: localPath,
    nodir: true,
    ignore: ignorePatterns,
    maxDepth: 8
  });

  return files.slice(0, maxFiles);
}

async function readFile(localPath, filePath) {
  const fullPath = path.join(localPath, filePath);
  if (!fullPath.startsWith(localPath)) throw new Error('Path traversal detected');
  const content = await fs.readFile(fullPath, 'utf-8');
  return content;
}

async function writeFile(localPath, filePath, content) {
  const fullPath = path.join(localPath, filePath);
  if (!fullPath.startsWith(localPath)) throw new Error('Path traversal detected');
  await fs.ensureDir(path.dirname(fullPath));
  await fs.writeFile(fullPath, content, 'utf-8');
  logger.info(`Wrote file: ${filePath}`);
}

async function commitAndPush(localPath, accessToken, username, repoFullName, message, changedFiles) {
  const git = simpleGit(localPath);

  await git.addConfig('user.email', 'codelite-ai@codelite.dev');
  await git.addConfig('user.name', 'CodeLite AI');

  for (const f of changedFiles) {
    await git.add(f);
  }

  await git.commit(message);

  const remoteUrl = `https://${accessToken}@github.com/${repoFullName}.git`;
  await git.addRemote('codelite-origin', remoteUrl).catch(() => {});
  await git.remote(['set-url', 'codelite-origin', remoteUrl]);

  const branch = (await git.branchLocal()).current;
  await git.push('codelite-origin', branch);

  logger.info(`Committed and pushed ${changedFiles.length} file(s) to ${repoFullName}`);
  return { success: true, branch, message };
}

async function getFilesContent(localPath, filePaths, maxCharsPerFile = 8000) {
  const result = {};
  for (const fp of filePaths) {
    try {
      let content = await readFile(localPath, fp);
      if (content.length > maxCharsPerFile) {
        content = content.substring(0, maxCharsPerFile) + '\n... [truncated]';
      }
      result[fp] = content;
    } catch (e) {
      result[fp] = `[unreadable: ${e.message}]`;
    }
  }
  return result;
}

module.exports = {
  listUserRepos,
  cloneOrUpdateRepo,
  getRepoFileTree,
  readFile,
  writeFile,
  commitAndPush,
  getFilesContent,
  REPOS_DIR
};
