import type { RepoView } from './types'

// A `Link` whose href the engine rejects makes it refuse the whole pane, so every
// URL goes through safeHref first and an unusable one just renders unlinked.
//
// The engine wants an `https:` URL of at most 2048 printable-ASCII characters,
// spelled as `new URL(href).href`, with no `@`, space or non-ASCII letter. This is
// stricter than that on purpose: a lower-case host, then a path and query of plain
// URL characters only, so there is nothing for URL normalization to rewrite.

const PRINTABLE_ASCII = /^[\x21-\x7e]{1,2048}$/
const HTTPS_URL = /^https:\/\/([^/?#]+)(\/.*)$/
const HOST = /^[a-z0-9.-]+$/
const PLAIN_PATH_AND_QUERY = /^[A-Za-z0-9._~/:%+=&?-]+$/
const BAD_PERCENT = /%(?![0-9A-Fa-f]{2})/
const DOT_SEGMENT = /(^|\/)\.\.?(\/|\?|$)/

/** `href` if the engine will take it as a Link target, else undefined. */
export const safeHref = (href: string | null | undefined): string | undefined => {
  if (!href || !PRINTABLE_ASCII.test(href) || href.includes('@')) return undefined
  const match = HTTPS_URL.exec(href)
  if (!match) return undefined
  const [, host, rest] = match
  if (!host || !rest || !HOST.test(host)) return undefined
  if (!PLAIN_PATH_AND_QUERY.test(rest) || BAD_PERCENT.test(rest) || DOT_SEGMENT.test(rest)) return undefined
  return href
}

/** Encodes each `/`-separated piece of a branch or tag name, keeping the slashes. */
const segments = (name: string): string => name.split('/').map(encodeURIComponent).join('/')

export type StepLinks = [string | undefined, string | undefined, string | undefined, string | undefined]

/**
 * Where each stepper step (PR, Build, Merged, Released) leads, in that order:
 * the PR the stepper follows (else the PR list), its checks (else the default
 * branch's workflow runs), the default branch's commits, and the latest release
 * (else the release list). Anything unusable comes back undefined.
 */
export const stepLinks = (r: RepoView): StepLinks => {
  const pr = r.prs[0]
  const pulls = pr ? pr.url : `${r.url}/pulls`
  const build = pr
    ? `${pr.url}/checks`
    : r.branch
      ? `${r.url}/actions?query=branch%3A${encodeURIComponent(r.branch)}`
      : `${r.url}/actions`
  const merged = r.branch ? `${r.url}/commits/${segments(r.branch)}` : undefined
  const released = r.release ? `${r.url}/releases/tag/${segments(r.release.tag)}` : `${r.url}/releases`
  return [safeHref(pulls), safeHref(build), safeHref(merged), safeHref(released)]
}

/**
 * What the repo's headline ("#25 building", "main build failing", ...) links to:
 * the PR itself for a conflict or a draft, otherwise the page that shows the build.
 */
export const headlineLink = (r: RepoView): string | undefined => {
  const pr = r.prs[0]
  if (pr && (pr.hasConflict || pr.isDraft)) return safeHref(pr.url)
  return stepLinks(r)[1]
}
