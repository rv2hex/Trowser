'use strict';

// Repo cards (src/gitcard.js): URL parsing, API payload normalization, card
// layout and the fetch wrapper's failure modes. The failure modes this pins:
// deep links (/tree, /-/issues) must resolve to the repo, not a bogus one;
// GitLab nested namespaces must survive URL-encoding; a missing language or
// license must not leave a dangling ' · '; a hung fetch must time out fast
// instead of wedging the UI; cache hits and expiry must be observable via
// the injected clock. No test touches the network.

const { describe, it } = require('node:test');
const assert = require('node:assert');

const { parseRepoUrl, apiUrlFor, parseRepoJson, formatRepoCard, createRepoCache, fetchRepoCard } = require('../src/gitcard');

const EXPRESS = { host: 'github', owner: 'expressjs', repo: 'express', path: '' };

const GH_FIXTURE = {
  name: 'express',
  full_name: 'expressjs/express',
  description: 'Fast, unopinionated, minimalist web framework',
  stargazers_count: 1234,
  forks_count: 567,
  open_issues_count: 89,
  language: 'JavaScript',
  license: { spdx_id: 'MIT', name: 'MIT License' },
  pushed_at: '2026-01-31T08:15:00Z',
  html_url: 'https://github.com/expressjs/express',
};

const GH_CARD = [
  'expressjs/express',
  'Fast, unopinionated, minimalist web framework',
  '★ 1234 · 567 forks · JavaScript · MIT',
  'updated 2026-01-31',
  'https://github.com/expressjs/express',
];

const GL_FIXTURE = {
  name: 'GitLab Runner',
  path: 'gitlab-runner',
  path_with_namespace: 'gitlab-org/gitlab-runner',
  description: 'Runner for GitLab CI/CD',
  star_count: 2500,
  forks_count: 620,
  open_issues_count: 42,
  license: { name: 'MIT License', nickname: 'MIT' },
  last_activity_at: '2026-02-01T10:00:00Z',
  web_url: 'https://gitlab.com/gitlab-org/gitlab-runner',
};

function jsonResponse(body, status = 200) {
  return { status, ok: status >= 200 && status < 300, json: async () => body };
}

describe('gitcard: parseRepoUrl', () => {
  it('reads plain github URLs, .git, trailing slash, www and http', () => {
    assert.deepEqual(parseRepoUrl('https://github.com/expressjs/express'), EXPRESS);
    assert.deepEqual(parseRepoUrl('https://github.com/expressjs/express.git'), EXPRESS);
    assert.deepEqual(parseRepoUrl('https://github.com/expressjs/express/'), EXPRESS);
    assert.deepEqual(parseRepoUrl('http://www.github.com/expressjs/express'), EXPRESS);
    assert.deepEqual(parseRepoUrl('  https://GitHub.com/expressjs/express  '), EXPRESS);
  });

  it('strips /tree, /blob, /issues, /pulls, /releases, /wiki and /commits deep links', () => {
    assert.deepEqual(parseRepoUrl('https://github.com/expressjs/express/tree/master/examples'), EXPRESS);
    assert.deepEqual(parseRepoUrl('https://github.com/expressjs/express/blob/master/lib/index.js'), EXPRESS);
    assert.deepEqual(parseRepoUrl('https://github.com/expressjs/express/issues/1234'), EXPRESS);
    assert.deepEqual(parseRepoUrl('https://github.com/expressjs/express/pulls?q=is%3Aopen'), EXPRESS);
    assert.deepEqual(parseRepoUrl('https://github.com/expressjs/express/releases/tag/5.0.0'), EXPRESS);
    assert.deepEqual(parseRepoUrl('https://github.com/expressjs/express/wiki'), EXPRESS);
    assert.deepEqual(parseRepoUrl('https://github.com/expressjs/express/commits/master'), EXPRESS);
  });

  it('ignores query and fragment on the repo itself', () => {
    assert.deepEqual(parseRepoUrl('https://github.com/expressjs/express?tab=readme-ov-file'), EXPRESS);
    assert.deepEqual(parseRepoUrl('https://github.com/expressjs/express#readme'), EXPRESS);
    assert.deepEqual(parseRepoUrl('https://github.com/expressjs/express/./'), EXPRESS);
  });

  it('keeps non-marker extra segments in path', () => {
    assert.equal(parseRepoUrl('https://github.com/expressjs/express/security/advisories').path, 'security/advisories');
    assert.equal(parseRepoUrl('https://github.com/expressjs/express/notes/commits/master').path, 'notes');
  });

  it('a repo whose own name is a marker word still parses', () => {
    assert.deepEqual(parseRepoUrl('https://github.com/owner/issues'), { host: 'github', owner: 'owner', repo: 'issues', path: '' });
  });

  it('gitlab keeps nested groups whole and drops /-/ deep links', () => {
    assert.deepEqual(parseRepoUrl('https://gitlab.com/gitlab-org/gitlab-runner'), { host: 'gitlab', owner: 'gitlab-org', repo: 'gitlab-runner', path: '' });
    assert.deepEqual(parseRepoUrl('https://gitlab.com/gitlab-org/security-products/analyzers/semgrep.git'), {
      host: 'gitlab',
      owner: 'gitlab-org/security-products/analyzers',
      repo: 'semgrep',
      path: '',
    });
    assert.deepEqual(parseRepoUrl('https://gitlab.com/gitlab-org/gitlab-runner/-/issues/12345'), { host: 'gitlab', owner: 'gitlab-org', repo: 'gitlab-runner', path: '' });
    assert.deepEqual(parseRepoUrl('https://gitlab.com/gitlab-org/gitlab-runner/-/tree/main/src'), { host: 'gitlab', owner: 'gitlab-org', repo: 'gitlab-runner', path: '' });
    assert.deepEqual(parseRepoUrl('https://www.gitlab.com/group/sub/project/'), { host: 'gitlab', owner: 'group/sub', repo: 'project', path: '' });
  });

  it('rejects other hosts, short paths, scheme-less input and garbage', () => {
    assert.equal(parseRepoUrl('https://bitbucket.org/atlassian/foo'), null);
    assert.equal(parseRepoUrl('https://gist.github.com/user/abc123'), null);
    assert.equal(parseRepoUrl('https://example.com/owner/repo'), null);
    assert.equal(parseRepoUrl('https://github.com/owner'), null);
    assert.equal(parseRepoUrl('https://gitlab.com/group'), null);
    assert.equal(parseRepoUrl('github.com/owner/repo'), null);
    assert.equal(parseRepoUrl('ftp://github.com/owner/repo'), null);
    assert.equal(parseRepoUrl('not a url'), null);
    assert.equal(parseRepoUrl(''), null);
    assert.equal(parseRepoUrl(null), null);
    assert.equal(parseRepoUrl(undefined), null);
  });
});

describe('gitcard: apiUrlFor', () => {
  it('hits the two public APIs, URL-encoding the gitlab namespace', () => {
    assert.equal(apiUrlFor(parseRepoUrl('https://github.com/expressjs/express')), 'https://api.github.com/repos/expressjs/express');
    assert.equal(apiUrlFor(parseRepoUrl('https://gitlab.com/gitlab-org/gitlab-runner')), 'https://gitlab.com/api/v4/projects/gitlab-org%2Fgitlab-runner');
    assert.equal(apiUrlFor(parseRepoUrl('https://gitlab.com/gitlab-org/security-products/analyzers/semgrep')), 'https://gitlab.com/api/v4/projects/gitlab-org%2Fsecurity-products%2Fanalyzers%2Fsemgrep');
    assert.equal(apiUrlFor(null), '');
  });
});

describe('gitcard: parseRepoJson', () => {
  it('maps a github payload, preferring license.spdx_id and pushed_at', () => {
    const info = parseRepoJson('github', GH_FIXTURE);
    assert.deepEqual(info, {
      host: 'github',
      name: 'express',
      fullName: 'expressjs/express',
      description: 'Fast, unopinionated, minimalist web framework',
      stars: 1234,
      forks: 567,
      language: 'JavaScript',
      license: 'MIT',
      updatedAt: '2026-01-31T08:15:00Z',
      openIssues: 89,
      url: 'https://github.com/expressjs/express',
    });
  });

  it('maps a gitlab payload, preferring license.name and last_activity_at', () => {
    const info = parseRepoJson('gitlab', GL_FIXTURE);
    assert.equal(info.host, 'gitlab');
    assert.equal(info.name, 'GitLab Runner');
    assert.equal(info.fullName, 'gitlab-org/gitlab-runner');
    assert.equal(info.description, 'Runner for GitLab CI/CD');
    assert.equal(info.stars, 2500);
    assert.equal(info.forks, 620);
    assert.equal(info.openIssues, 42);
    assert.equal(info.license, 'MIT License');
    assert.equal(info.updatedAt, '2026-02-01T10:00:00Z');
    assert.equal(info.url, 'https://gitlab.com/gitlab-org/gitlab-runner');
  });

  it('degrades to empty strings and 0 — never undefined', () => {
    for (const info of [parseRepoJson('github', {}), parseRepoJson('github', null), parseRepoJson('gitlab', undefined)]) {
      for (const key of ['name', 'fullName', 'description', 'language', 'license', 'updatedAt', 'url']) {
        assert.equal(typeof info[key], 'string', key);
        assert.equal(info[key], '', key);
      }
      for (const key of ['stars', 'forks', 'openIssues']) {
        assert.equal(info[key], 0, key);
      }
    }
    assert.equal(parseRepoJson('gitlab', { license: { nickname: 'MIT' } }).license, 'MIT');
    assert.equal(parseRepoJson('github', { license: { spdx_id: 'NOASSERTION', name: 'Other' } }).license, 'Other');
    assert.equal(parseRepoJson('github', { license: 'Apache-2.0' }).license, 'Apache-2.0');
    assert.equal(parseRepoJson('gitlab', { star_count: 3, path_with_namespace: 'g/p', web_url: 'https://gitlab.com/g/p' }).stars, 3);
  });
});

describe('gitcard: formatRepoCard', () => {
  it('lays out a full card as plain text lines', () => {
    assert.deepEqual(formatRepoCard(parseRepoJson('github', GH_FIXTURE)), GH_CARD);
  });

  it('drops missing parts whole — no doubled or dangling separators', () => {
    const sparse = parseRepoJson('github', {
      full_name: 'acme/thing',
      description: 'A thing',
      forks_count: 3,
      updated_at: '2026-03-04T00:00:00Z',
      html_url: 'https://github.com/acme/thing',
    });
    const lines = formatRepoCard(sparse);
    assert.deepEqual(lines, ['acme/thing', 'A thing', '3 forks', 'updated 2026-03-04', 'https://github.com/acme/thing']);
    assert.ok(!/·\s*·|^ ?·|· ?$/.test(lines.join('\n')), lines.join('\n'));
  });

  it('omits stats/date/url lines entirely rather than leaving them blank', () => {
    assert.deepEqual(formatRepoCard(parseRepoJson('github', { full_name: 'acme/tiny' })), ['acme/tiny']);
    assert.deepEqual(formatRepoCard({}), []);
    assert.deepEqual(formatRepoCard(null), []);
  });

  it('stars-only and singular fork stats stay grammatical', () => {
    assert.equal(formatRepoCard({ fullName: 'a/b', stars: 5 })[1], '★ 5');
    assert.equal(formatRepoCard({ fullName: 'a/b', forks: 1 })[1], '1 fork');
    assert.deepEqual(formatRepoCard({ fullName: 'a/b', stars: 0, forks: 0 }), ['a/b']);
  });

  it('wraps long descriptions at 76 cells and hard-breaks monster words', () => {
    const desc = 'abcd '.repeat(20).trim();
    const lines = formatRepoCard({ fullName: 'a/b', description: desc });
    for (const line of lines) assert.ok(line.length <= 76, `too wide: ${line.length}`);
    assert.equal(lines.slice(1).join(' '), desc);
    assert.ok(lines.length > 2);

    const big = formatRepoCard({ fullName: 'a/b', description: 'x'.repeat(100) });
    assert.deepEqual(big, ['a/b', 'x'.repeat(76), 'x'.repeat(24)]);
  });

  it('prints updated only when the timestamp is parseable, as YYYY-MM-DD', () => {
    assert.deepEqual(formatRepoCard({ fullName: 'a/b', updatedAt: '2026-01-31T23:59:59Z' }), ['a/b', 'updated 2026-01-31']);
    assert.deepEqual(formatRepoCard({ fullName: 'a/b', updatedAt: '2026-01-31' }), ['a/b', 'updated 2026-01-31']);
    assert.deepEqual(formatRepoCard({ fullName: 'a/b', updatedAt: 'last tuesday' }), ['a/b']);
  });
});

describe('gitcard: createRepoCache', () => {
  it('serves unexpired entries and evicts expired ones on read', () => {
    let t = 1000;
    const cache = createRepoCache({ ttlMs: 100, now: () => t });
    cache.set('k', { v: 1 });
    assert.deepEqual(cache.get('k'), { v: 1 });
    t += 99;
    assert.deepEqual(cache.get('k'), { v: 1 });
    t += 1;
    assert.equal(cache.get('k'), undefined);
    assert.equal(cache.get('missing'), undefined);
  });

  it('caps at 64 entries, evicting oldest inserted first; a re-set refreshes order', () => {
    let t = 0;
    const cache = createRepoCache({ ttlMs: 60000, now: () => t++ });
    for (let i = 0; i < 70; i++) cache.set(`k${i}`, i);
    assert.equal(cache.get('k0'), undefined);
    assert.equal(cache.get('k5'), undefined);
    assert.equal(cache.get('k6'), 6);
    assert.equal(cache.get('k69'), 69);

    const small = createRepoCache({ ttlMs: 60000, now: () => 0 });
    small.set('a', 1);
    for (let i = 0; i < 64; i++) small.set(`x${i}`, i);
    small.set('a', 2); // refreshes 'a' to the newest slot
    assert.equal(small.get('a'), 2);
  });
});

describe('gitcard: fetchRepoCard', () => {
  it('fetches once with the required headers, then serves the cache', async () => {
    const cache = createRepoCache({ ttlMs: 600000, now: () => 0 });
    const calls = [];
    const fetchImpl = async (url, opts) => {
      calls.push({ url, opts });
      return jsonResponse(GH_FIXTURE);
    };
    const url = 'https://github.com/expressjs/express';

    const first = await fetchRepoCard(url, { fetchImpl, cache });
    assert.equal(first.ok, true);
    assert.equal(first.cached, false);
    assert.deepEqual(first.lines, GH_CARD);
    assert.equal(first.info.fullName, 'expressjs/express');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://api.github.com/repos/expressjs/express');
    assert.equal(calls[0].opts.headers['User-Agent'], 'tui-browser');
    assert.equal(calls[0].opts.headers.Accept, 'application/json');
    assert.ok(calls[0].opts.signal, 'abort signal passed through');

    const second = await fetchRepoCard(url, { fetchImpl, cache });
    assert.equal(second.ok, true);
    assert.equal(second.cached, true);
    assert.deepEqual(second.lines, GH_CARD);
    assert.equal(calls.length, 1, 'cache hit must not fetch again');
  });

  it('deep links to one repo share a cache key', async () => {
    const cache = createRepoCache({ ttlMs: 600000, now: () => 0 });
    let count = 0;
    const fetchImpl = async () => {
      count++;
      return jsonResponse(GH_FIXTURE);
    };
    await fetchRepoCard('https://github.com/expressjs/express/tree/master/examples', { fetchImpl, cache });
    const hit = await fetchRepoCard('https://github.com/expressjs/express', { fetchImpl, cache });
    assert.equal(hit.cached, true);
    assert.equal(count, 1);
  });

  it('an expired entry refetches instead of serving stale data', async () => {
    let t = 0;
    const cache = createRepoCache({ ttlMs: 1000, now: () => t });
    let count = 0;
    const fetchImpl = async () => {
      count++;
      return jsonResponse(GH_FIXTURE);
    };
    const url = 'https://github.com/expressjs/express';
    const first = await fetchRepoCard(url, { fetchImpl, cache, now: () => t });
    assert.equal(first.cached, false);
    t = 1000;
    const again = await fetchRepoCard(url, { fetchImpl, cache, now: () => t });
    assert.equal(again.cached, false);
    assert.equal(count, 2);
  });

  it('gitlab repos go through the encoded project endpoint', async () => {
    const seen = [];
    const res = await fetchRepoCard('https://gitlab.com/gitlab-org/gitlab-runner', {
      fetchImpl: async (url) => {
        seen.push(url);
        return jsonResponse(GL_FIXTURE);
      },
    });
    assert.equal(res.ok, true);
    assert.equal(seen[0], 'https://gitlab.com/api/v4/projects/gitlab-org%2Fgitlab-runner');
    assert.deepEqual(res.lines, [
      'gitlab-org/gitlab-runner',
      'Runner for GitLab CI/CD',
      '★ 2500 · 620 forks · MIT License',
      'updated 2026-02-01',
      'https://gitlab.com/gitlab-org/gitlab-runner',
    ]);
  });

  it('a hung fetch times out fast with "timed out"', async () => {
    const started = Date.now();
    const res = await fetchRepoCard('https://github.com/expressjs/express', {
      fetchImpl: () => new Promise(() => {}),
      timeoutMs: 30,
    });
    assert.deepEqual(res, { ok: false, error: 'timed out' });
    assert.ok(Date.now() - started < 2000, 'timeout must not wait for the default 8s');
  });

  it('non-2xx maps to HTTP <status>', async () => {
    const res = await fetchRepoCard('https://github.com/expressjs/express', {
      fetchImpl: async () => jsonResponse({ message: 'Not Found' }, 404),
    });
    assert.deepEqual(res, { ok: false, error: 'HTTP 404' });
    const server = await fetchRepoCard('https://github.com/expressjs/express', {
      fetchImpl: async () => jsonResponse({ message: 'boom' }, 500),
    });
    assert.deepEqual(server, { ok: false, error: 'HTTP 500' });
  });

  it('a non-repo URL fails before any fetch', async () => {
    let called = false;
    const res = await fetchRepoCard('https://example.com/owner/repo', {
      fetchImpl: async () => {
        called = true;
        return jsonResponse({});
      },
    });
    assert.deepEqual(res, { ok: false, error: 'not a repo url' });
    assert.equal(called, false);
  });

  it('bad json and transport errors are reported, never thrown', async () => {
    const bad = await fetchRepoCard('https://github.com/expressjs/express', {
      fetchImpl: async () => ({ status: 200, json: async () => { throw new SyntaxError('Unexpected token <'); } }),
    });
    assert.deepEqual(bad, { ok: false, error: 'bad json' });

    const notObject = await fetchRepoCard('https://github.com/expressjs/express', {
      fetchImpl: async () => jsonResponse('nope'),
    });
    assert.deepEqual(notObject, { ok: false, error: 'bad json' });

    const boom = await fetchRepoCard('https://github.com/expressjs/express', {
      fetchImpl: async () => {
        throw new Error('socket closed');
      },
    });
    assert.deepEqual(boom, { ok: false, error: 'socket closed' });
  });

  it('a failed fetch leaves the cache empty', async () => {
    const cache = createRepoCache({ ttlMs: 600000, now: () => 0 });
    await fetchRepoCard('https://github.com/expressjs/express', {
      fetchImpl: async () => jsonResponse({}, 503),
      cache,
    });
    assert.equal(cache.get('github:expressjs/express'), undefined);
  });
});
