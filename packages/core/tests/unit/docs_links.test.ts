import { describe, expect, it } from 'vitest';
import { rewriteDocLink, slugFor, titleFrom } from '../../src/docs/links';

describe('rewriteDocLink', () => {
  it('maps a README-relative guide link to its site route', () => {
    expect(rewriteDocLink('guide/concepts.md', 'root')).toBe('/docs/guide/concepts');
  });

  it('maps a README-relative internals link to its site route', () => {
    expect(rewriteDocLink('internals/persistence.md', 'root')).toBe('/docs/internals/persistence');
  });

  it('resolves ../ from a guide doc into internals and preserves the fragment', () => {
    expect(rewriteDocLink('../internals/persistence.md#async-tool-resumption', 'guide')).toBe(
      '/docs/internals/persistence#async-tool-resumption',
    );
  });

  it('keeps same-group links within the group, with fragment', () => {
    expect(rewriteDocLink('manifest-reference.md#speccontainers', 'guide')).toBe(
      '/docs/guide/manifest-reference#speccontainers',
    );
  });

  it('maps the docs-root README to the overview index', () => {
    expect(rewriteDocLink('README.md', 'root')).toBe('/docs/home');
    // From a guide doc, the overview is one level up.
    expect(rewriteDocLink('../README.md', 'guide')).toBe('/docs/home');
  });

  it('leaves in-page anchors untouched', () => {
    expect(rewriteDocLink('#local-dev-secrets', 'guide')).toBe('#local-dev-secrets');
  });

  it('leaves absolute and mailto links untouched', () => {
    expect(rewriteDocLink('https://anthropic.com/x', 'root')).toBe('https://anthropic.com/x');
    expect(rewriteDocLink('mailto:a@b.com', 'root')).toBe('mailto:a@b.com');
    expect(rewriteDocLink('//cdn.example.com/x', 'root')).toBe('//cdn.example.com/x');
  });

  it('points links that escape docs/ at the GitHub blob tree', () => {
    expect(rewriteDocLink('../../examples/sandbox-worker/', 'guide')).toBe(
      'https://github.com/blakebauman/felix-run/blob/main/examples/sandbox-worker/',
    );
    expect(rewriteDocLink('../../src/app.ts', 'internals')).toBe(
      'https://github.com/blakebauman/felix-run/blob/main/src/app.ts',
    );
  });

  it('routes a non-.md path that stays inside docs/ to GitHub (e.g. a directory)', () => {
    expect(rewriteDocLink('internals/', 'root')).toBe(
      'https://github.com/blakebauman/felix-run/blob/main/docs/internals/',
    );
  });
});

describe('slugFor', () => {
  it('maps README to index and strips .md otherwise', () => {
    expect(slugFor('README.md')).toBe('index');
    expect(slugFor('guide/concepts.md')).toBe('guide/concepts');
    expect(slugFor('internals/persistence.md')).toBe('internals/persistence');
  });
});

describe('titleFrom', () => {
  it('extracts the first H1, else falls back', () => {
    expect(titleFrom('# Concepts\n\nbody', 'fallback')).toBe('Concepts');
    expect(titleFrom('no heading here', 'Fallback Title')).toBe('Fallback Title');
  });
});
