/**
 * GitHub-based skill search and preview — Phase 4
 *
 * Uses GitHub REST API (no auth required for public repos)
 * to search for skill repositories and preview their contents
 * before installation.
 */
import chalk from 'chalk';
import ora from 'ora';
import type { SkillFrontmatter } from '../types/index.js';
import { logger } from '../utils/logger.js';

/** GitHub API search response types */
interface GitHubSearchResult {
  total_count: number;
  items: GitHubRepo[];
}

interface GitHubRepo {
  full_name: string;
  description: string | null;
  html_url: string;
  stargazers_count: number;
  updated_at: string;
  language: string | null;
  topics: string[];
  license: { spdx_id: string } | null;
}

interface GitHubContent {
  name: string;
  path: string;
  type: 'file' | 'dir';
  content?: string;
  encoding?: string;
}

const GITHUB_API = 'https://api.github.com';

/**
 * Fetch wrapper with retry logic
 */
async function fetchWithRetry(url: string, options: RequestInit, maxRetries = 3): Promise<Response> {
  let attempts = 0;
  while (attempts < maxRetries) {
    try {
      const response = await fetch(url, options);
      // Don't retry on 404s or 403s (rate limits) unless they are 5xx server errors
      if (!response.ok && response.status >= 500) {
        throw new Error(`Server Error: ${response.status}`);
      }
      return response;
    } catch (err) {
      attempts++;
      if (attempts >= maxRetries) {
        throw err;
      }
      // Exponential backoff
      await new Promise(resolve => setTimeout(resolve, attempts * 1000));
    }
  }
  throw new Error('Unreachable');
}

/**
 * Search for skills on GitHub.
 *
 * Searches for repositories containing SKILL.md, optionally filtered by query.
 * Respects GitHub API rate limits (60 req/hour unauthenticated).
 */
export async function searchSkills(
  query: string,
  options: { limit?: number } = {}
): Promise<void> {
  const spinner = ora('Searching GitHub...').start();
  const limit = options.limit || 15;

  try {
    // Search repos that contain SKILL.md and match the query
    const searchQuery = encodeURIComponent(
      `${query} SKILL.md in:path filename:SKILL.md`
    );
    const url = `${GITHUB_API}/search/repositories?q=${searchQuery}&sort=stars&order=desc&per_page=${limit}`;

    const response = await fetchWithRetry(url, {
      headers: { Accept: 'application/vnd.github.v3+json' },
    });

    if (!response.ok) {
      if (response.status === 403) {
        spinner.fail('GitHub API rate limit exceeded. Try again later or use a token.');
        return;
      }
      spinner.fail(`GitHub API error: ${response.status}`);
      return;
    }

    const data = (await response.json()) as GitHubSearchResult;
    spinner.stop();

    if (data.total_count === 0) {
      logger.info(`No skills found for "${query}"`);
      if (logger.isJsonMode()) logger.json([]);
      return;
    }

    if (logger.isJsonMode()) {
      logger.json(data.items);
      return;
    }

    logger.blank();
    console.log(chalk.bold(`  Found ${data.total_count} result(s) for "${query}":`));
    logger.blank();

    for (const repo of data.items) {
      const stars = chalk.yellow(`★ ${repo.stargazers_count}`);
      const name = chalk.cyan.bold(repo.full_name);
      const desc = repo.description
        ? chalk.gray(repo.description.substring(0, 60))
        : chalk.gray('(no description)');
      const license = repo.license?.spdx_id
        ? chalk.gray(`[${repo.license.spdx_id}]`)
        : '';
      const topics = repo.topics.length
        ? chalk.gray(repo.topics.slice(0, 3).map((t) => `#${t}`).join(' '))
        : '';

      console.log(`  ${name}  ${stars}  ${license}`);
      console.log(`    ${desc}`);
      if (topics) console.log(`    ${topics}`);
      console.log(`    ${chalk.blue(`skm install ${repo.full_name}`)}`);
      logger.blank();
    }

    logger.info(`Showing ${data.items.length} of ${data.total_count} results`);
  } catch (err) {
    spinner.fail(`Search failed: ${(err as Error).message}`);
  }
}

/**
 * Preview a skill before installing — security review.
 *
 * Fetches and displays:
 *   - SKILL.md frontmatter (name, description, allowed-tools)
 *   - skillpkg.yaml (deps, MCP services, scripts)
 *   - Directory structure
 *   - Security warnings (scripts, env vars, etc.)
 */
export async function previewSkill(source: string): Promise<void> {
  const spinner = ora('Fetching skill info...').start();

  try {
    // Parse source to get owner/repo
    const { parseSourceString } = await import('../parsers/index.js');
    const { repoUrl, skillPath, version } = parseSourceString(source);

    // Extract owner/repo from URL
    const match = repoUrl.match(/github\.com\/([^/]+\/[^/]+)/);
    if (!match) {
      spinner.fail('Only GitHub repositories are supported for preview');
      return;
    }
    const repoPath = match[1].replace(/\.git$/, '');
    const ref = version || 'HEAD';

    // Fetch repo info
    const repoRes = await fetchWithRetry(`${GITHUB_API}/repos/${repoPath}`, {
      headers: { Accept: 'application/vnd.github.v3+json' },
    });
    if (!repoRes.ok) {
      spinner.fail(`Repository not found: ${repoPath}`);
      return;
    }
    const repoInfo = (await repoRes.json()) as GitHubRepo;

    // Fetch SKILL.md content
    const skillMdPath = skillPath ? `${skillPath}/SKILL.md` : 'SKILL.md';
    const contentRes = await fetchWithRetry(
      `${GITHUB_API}/repos/${repoPath}/contents/${skillMdPath}`,
      { headers: { Accept: 'application/vnd.github.v3+json' } }
    );

    // Fetch skillpkg.yaml content
    const pkgPath = skillPath ? `${skillPath}/skillpkg.yaml` : 'skillpkg.yaml';
    const pkgRes = await fetchWithRetry(
      `${GITHUB_API}/repos/${repoPath}/contents/${pkgPath}`,
      { headers: { Accept: 'application/vnd.github.v3+json' } }
    );

    // Fetch directory listing
    const dirPath = skillPath || '';
    const dirRes = await fetchWithRetry(
      `${GITHUB_API}/repos/${repoPath}/contents/${dirPath}`,
      { headers: { Accept: 'application/vnd.github.v3+json' } }
    );

    spinner.stop();
    logger.blank();

    // ── Header ──
    console.log(chalk.bold.cyan(`  ┌─ Preview: ${repoPath}${skillPath ? `/${skillPath}` : ''}`));
    console.log(chalk.gray(`  │  ${repoInfo.html_url}`));
    console.log(chalk.gray(`  │  ★ ${repoInfo.stargazers_count}  ${repoInfo.language || ''}  ${repoInfo.license?.spdx_id || ''}`));
    if (repoInfo.description) {
      console.log(chalk.gray(`  │  ${repoInfo.description}`));
    }
    console.log(chalk.gray('  │'));

    // ── SKILL.md ──
    if (contentRes.ok) {
      const contentData = (await contentRes.json()) as GitHubContent;
      if (contentData.content && contentData.encoding === 'base64') {
        const decoded = Buffer.from(contentData.content, 'base64').toString('utf-8');
        const { default: grayMatter } = await import('gray-matter');
        const { data } = grayMatter(decoded);
        const fm = data as Record<string, unknown>;

        console.log(chalk.bold('  │  📄 SKILL.md'));
        console.log(`  │    Name:        ${chalk.cyan(String(fm['name'] || '—'))}`);
        console.log(`  │    Description: ${fm['description'] || '—'}`);
        if (fm['license']) console.log(`  │    License:     ${fm['license']}`);
        if (fm['allowed-tools']) {
          console.log(`  │    Tools:       ${chalk.yellow(String(fm['allowed-tools']))}`);
        }
      }
    } else {
      console.log(chalk.red('  │  ⚠ No SKILL.md found'));
    }

    console.log(chalk.gray('  │'));

    // ── skillpkg.yaml ──
    if (pkgRes.ok) {
      const pkgData = (await pkgRes.json()) as GitHubContent;
      if (pkgData.content && pkgData.encoding === 'base64') {
        const decoded = Buffer.from(pkgData.content, 'base64').toString('utf-8');
        const { parse: yamlParse } = await import('yaml');
        const manifest = yamlParse(decoded) as Record<string, unknown>;

        console.log(chalk.bold('  │  📦 skillpkg.yaml'));
        console.log(`  │    Version:     ${manifest['version'] || '—'}`);

        // Dependencies
        const deps = manifest['dependencies'] as unknown[];
        if (Array.isArray(deps) && deps.length > 0) {
          console.log(`  │    Dependencies (${deps.length}):`);
          for (const d of deps) {
            const dep = d as Record<string, unknown>;
            console.log(`  │      - ${dep['name']}: ${dep['source']}`);
          }
        }

        // MCP services
        const mcps = manifest['mcp'] as unknown[];
        if (Array.isArray(mcps) && mcps.length > 0) {
          console.log(`  │    MCP Services (${mcps.length}):`);
          for (const m of mcps) {
            const mcp = m as Record<string, unknown>;
            console.log(`  │      - ${mcp['name']}: ${mcp['command']} ${mcp['type'] || 'stdio'}`);
          }
        }

        // Replace directives
        const replaces = manifest['replace'] as unknown[];
        if (Array.isArray(replaces) && replaces.length > 0) {
          console.log(`  │    Replace directives (${replaces.length}):`);
          for (const r of replaces) {
            const rep = r as Record<string, unknown>;
            console.log(`  │      ${rep['old']} => ${rep['new']}`);
          }
        }

        // Scripts — security concern
        const scripts = manifest['scripts'] as Record<string, unknown> | undefined;
        if (scripts && Object.keys(scripts).length > 0) {
          console.log(chalk.yellow(`  │    ⚠ Lifecycle Scripts:`));
          for (const [hook, cmd] of Object.entries(scripts)) {
            console.log(chalk.yellow(`  │      ${hook}: ${cmd}`));
          }
        }
      }
    }

    console.log(chalk.gray('  │'));

    // ── Directory structure ──
    if (dirRes.ok) {
      const dirResClone = dirRes.clone();
      const entries = (await dirRes.json()) as GitHubContent[];
      if (Array.isArray(entries)) {
        console.log(chalk.bold('  │  📂 Files'));
        for (const entry of entries.slice(0, 20)) {
          const icon = entry.type === 'dir' ? '📁' : '📄';
          console.log(`  │    ${icon} ${entry.name}`);
        }
        if (entries.length > 20) {
          console.log(chalk.gray(`  │    ... and ${entries.length - 20} more`));
        }
      }

      // ── Security summary ──
      console.log(chalk.gray('  │'));
      console.log(chalk.bold('  │  🔒 Security Summary'));

      const warnings: string[] = [];
      const dangerousPatterns = [/curl\s/, /wget\s/, /rm\s+-rf/, /sudo\s/, /chmod\s+\+x/, /bash\s+-c/];

      if (pkgRes.ok) {
        const pkgData = (await pkgRes.clone().json()) as GitHubContent;
        if (pkgData.content) {
          const decoded = Buffer.from(pkgData.content, 'base64').toString('utf-8');
          if (decoded.includes('scripts:') && !decoded.match(/scripts:\s*\{\}/)) {
            warnings.push('Contains lifecycle scripts that will execute on install');
            
            // Basic command scanning
            for (const pattern of dangerousPatterns) {
              if (pattern.test(decoded)) {
                warnings.push(`Script contains potentially dangerous command matching: ${pattern.toString()}`);
              }
            }
          }
          if (decoded.includes('env:')) {
            warnings.push('Requests environment variable access');
          }
          if (decoded.includes('mcp:')) {
            warnings.push('Registers MCP servers on your system');
          }
        }
      }

      const dirEntries = (await dirResClone.json()) as GitHubContent[];
      if (Array.isArray(dirEntries)) {
        const hasScripts = dirEntries.some(e => e.type === 'file' && (e.name.endsWith('.sh') || e.name.endsWith('.bat') || e.name.endsWith('.ps1')));
        if (hasScripts) {
          warnings.push('Repository contains shell/batch scripts (.sh, .bat, .ps1)');
        }
      }

      if (warnings.length === 0) {
        console.log(chalk.green('  │    ✔ No security concerns detected'));
      } else {
        for (const w of warnings) {
          console.log(chalk.yellow(`  │    ⚠ ${w}`));
        }
      }
    }

    console.log(chalk.gray('  └──'));
    logger.blank();
    console.log(`  Install: ${chalk.cyan(`skm install ${source}`)}`);
    console.log(`  Install (run scripts after review): ${chalk.cyan(`skm install ${source} --run-scripts`)}`);
    console.log(`  Install (always skip scripts): ${chalk.cyan(`skm install ${source} --no-scripts`)}`);
    logger.blank();
  } catch (err) {
    spinner.fail(`Preview failed: ${(err as Error).message}`);
  }
}
