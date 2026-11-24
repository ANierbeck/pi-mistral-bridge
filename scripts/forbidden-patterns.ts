// scripts/forbidden-patterns.ts
// The ONE list of strings that must never enter this public repository
// (AGENTS.md §8). It is shared by the commit-range scan
// (scripts/secret-scan.ts, wired as the .githooks/pre-push hook and as the CI
// `secret-scan` job). Generic credentials (API keys, tokens) are gitleaks'
// job; a gitleaks false positive is allowlisted in .gitleaksignore with a
// comment.
//
// Every pattern carries a comment saying WHY it is forbidden. The patterns
// are assembled from fragments so this file does not match itself.

export interface ForbiddenPattern {
  name: string;
  re: RegExp;
}

export const FORBIDDEN: readonly ForbiddenPattern[] = [
  // Absolute home-directory paths leak the layout of the owner's machine.
  { name: 'absolute home path', re: new RegExp(['/(Users|home)', '/'].join('')) },
  // The owner's public handle in its lowercase form, as it appears in URLs,
  // e-mail addresses and paths (profile URLs, mail addresses). Case-
  // sensitive on purpose: LICENSE and package.json deliberately carry the
  // capitalized legal name as copyright holder / author, which is the
  // owner's explicit publication choice, not a leaked handle.
  { name: 'owner handle', re: new RegExp(['anier', 'beck'].join('')) },
  // The owner's first name must not appear as a standalone word. Split into
  // fragments so this file does not match itself.
  { name: 'owner first name', re: new RegExp(['\\b', 'ac', 'him', '\\b'].join(''), 'i') },
  // The owner's employer must not appear in a public repo.
  { name: 'employer', re: new RegExp(['code', 'centric'].join(''), 'i') },
  // The owner's private mail domain must not appear in a public repo.
  { name: 'private mail domain', re: new RegExp(['gmx', '\\.de'].join('')) },
  // The owner's other private project must not be referenced.
  { name: 'sibling private project', re: new RegExp(['Private', '-Chat'].join(''), 'i') },
  // Tailnet hostnames expose private infrastructure.
  { name: 'tailnet hostname', re: new RegExp(['\\.ts', '\\.net\\b'].join('')) },
  // Webhook URLs expose private infrastructure endpoints.
  { name: 'webhook URL', re: new RegExp(['/api', '/webhook/'].join('')) },
  // A leaked bearer token (HTTP Authorization header value). The character
  // class deliberately excludes '{', '<' and non-ASCII, so documentation
  // placeholders like "Bearer {{TOKEN}}" or "Bearer …" do not match.
  { name: 'bearer token', re: new RegExp(['Bearer\\s+', '[A-Za-z0-9\\-._~+/]{16,}'].join('')) },
  // Mistral API keys ("sk-..." literals). The \b and the 20+ char tail keep
  // ordinary words like "task-" from matching.
  { name: 'API key literal', re: new RegExp(['\\bsk-', '[A-Za-z0-9]{20,}'].join('')) },
  // Raw vibe-acp JSON-RPC trace lines as written by the spike logs under
  // spikes/out/ (session content of the owner's paid runs must never be
  // committed). Assembled from fragments so this file does not match itself.
  { name: 'vibe-acp raw trace line', re: new RegExp(['"dir":"', '(client|agent)->'].join('')) },
];

/** Generated files that legitimately carry third-party metadata. */
export const SKIP_PATHS: ReadonlySet<string> = new Set(['package-lock.json']);
