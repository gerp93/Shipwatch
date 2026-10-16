// A PR that is set aside: a draft, or one whose title says not to merge it. Such PRs are work in progress or
// kept open on purpose, so by default they are neither shown nor counted when judging where a repo stands.

/** Titles that mean "never merge this" ("DO NOT MERGE: ...", "[do-not-merge] ..."). */
export const NOT_FOR_MERGE = /\bdo[\s-]?not[\s-]?merge\b/i

/** Whether a PR is set aside. */
export const isParked = (title: string, isDraft: boolean): boolean => isDraft || NOT_FOR_MERGE.test(title)
