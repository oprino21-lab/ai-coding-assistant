const path = require('path');
const fs = require('fs-extra');
const logger = require('../utils/logger');
const { getRepoFileTree, getFilesContent } = require('./githubService');

async function analyzeRepo(localPath) {
  logger.info(`Analyzing repo at: ${localPath}`);

  const allFiles = await getRepoFileTree(localPath);
  const structure = buildTree(allFiles);
  const techStack = detectTechStack(allFiles, localPath);
  const keyFiles = selectKeyFiles(allFiles);
  const keyContents = await getFilesContent(localPath, keyFiles, 6000);

  const summary = {
    totalFiles: allFiles.length,
    fileTree: allFiles,
    structure,
    techStack,
    keyFiles,
    keyContents,
    analyzedAt: new Date().toISOString()
  };

  logger.info(`Repo analysis complete: ${allFiles.length} files, stack: ${JSON.stringify(techStack.detected)}`);
  return summary;
}

function buildTree(files) {
  const tree = {};
  for (const file of files) {
    const parts = file.split('/');
    let node = tree;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!node[parts[i]]) node[parts[i]] = {};
      node = node[parts[i]];
    }
    node[parts[parts.length - 1]] = null;
  }
  return tree;
}

function detectTechStack(files, localPath) {
  const detected = [];
  const fileSet = new Set(files.map(f => path.basename(f)));
  const allPaths = files.join('\n');

  if (fileSet.has('package.json')) {
    detected.push('Node.js');
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(localPath, 'package.json'), 'utf-8'));
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      if (deps.react)                              detected.push('React');
      if (deps.vue)                                detected.push('Vue');
      if (deps['@angular/core'])                   detected.push('Angular');
      if (deps.next)                               detected.push('Next.js');
      if (deps.express)                            detected.push('Express');
      if (deps.typescript || deps.ts)              detected.push('TypeScript');
      if (deps.prisma)                             detected.push('Prisma');
      if (deps.mongoose || deps.mongodb)           detected.push('MongoDB');
    } catch (_) {}
  }

  if (fileSet.has('requirements.txt') || fileSet.has('setup.py') || fileSet.has('pyproject.toml')) {
    detected.push('Python');
    if (allPaths.includes('django'))  detected.push('Django');
    if (allPaths.includes('flask'))   detected.push('Flask');
    if (allPaths.includes('fastapi')) detected.push('FastAPI');
  }

  if (fileSet.has('go.mod'))           detected.push('Go');
  if (fileSet.has('Cargo.toml'))       detected.push('Rust');
  if (fileSet.has('composer.json'))    detected.push('PHP');
  if (fileSet.has('Gemfile'))          detected.push('Ruby');
  if (fileSet.has('pom.xml') || fileSet.has('build.gradle')) detected.push('Java');
  if (fileSet.has('Dockerfile') || fileSet.has('docker-compose.yml')) detected.push('Docker');

  const extensions = {};
  for (const f of files) {
    const ext = path.extname(f).toLowerCase();
    if (ext) extensions[ext] = (extensions[ext] || 0) + 1;
  }

  return { detected: [...new Set(detected)], extensions };
}

function selectKeyFiles(files) {
  const priority = [
    'README.md', 'package.json', 'requirements.txt', 'go.mod', 'Cargo.toml',
    'pyproject.toml', 'setup.py', '.env.example', 'docker-compose.yml',
    'Dockerfile', 'tsconfig.json'
  ];

  const selected = [];

  for (const p of priority) {
    const match = files.find(f => path.basename(f) === p);
    if (match) selected.push(match);
  }

  const sourceExts = ['.js', '.ts', '.py', '.go', '.rs', '.rb', '.php', '.java', '.jsx', '.tsx'];
  const sourceFiles = files
    .filter(f => sourceExts.includes(path.extname(f)))
    .filter(f => !f.includes('test') && !f.includes('spec') && !f.includes('.min.'))
    .sort((a, b) => a.split('/').length - b.split('/').length)
    .slice(0, 15);

  for (const f of sourceFiles) {
    if (!selected.includes(f)) selected.push(f);
  }

  return selected.slice(0, 25);
}

module.exports = { analyzeRepo };
