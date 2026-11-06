#!/usr/bin/env bash
# Document numbers stay out of code: the airdress workspace rule of that
# name, kept in the airdress-ops repository. Spec, RDR and RCP numbers
# belong in comments and Markdown, never in identifiers, strings, keys or
# file names.
#
# Checks every tracked file (arguments are ignored: a rename elsewhere in the
# tree is as much a violation as one in the staged files):
#
#   1. Path: fails when a tracked path matches (?i)(spec|rdr|rcp)[_-]?[0-9]{3}
#      outside documentation (docs/, research/, runbooks/, .spec-workflow,
#      CHANGELOG*, *.md).
#   2. Content: fails when a non-comment line of a code file contains a
#      document number, or an AC/FR/NFR/OQ/gate id used as a name
#      (FINE_RE). A line is a comment when, after leading whitespace, it
#      starts with // /// # -- * or /*; a trailing `// …`, ` # …` or ` -- …`
#      segment is also a comment.
#
# The number is matched as a token: not preceded by a letter or digit, not
# followed by a digit. That is `\b…\b` from the rule, except that `_` is
# allowed on the right — otherwise `spec_054_foo` (the most common offender)
# would slip through because `_` is a word character.
#
# Exemptions:
#
#   - A trailing `allow-doc-number: <reason>` on the line. Reviewed, sparing.
#   - Billing attribution: `spec = "spec-NNN"` labels / Stripe metadata, and
#     `tags = [...]` / `topics = [...]` lists. They are the cost-attribution
#     key the billing export groups by (the workspace "Resource labels" rule; Vultr
#     and Hetzner carry it as a tag) — an external contract, not a name.
#   - Prose attributes nobody addresses by name: `description`,
#     `display_name`, `title`, `notes`, `comment`, `desc`, `gecos`,
#     `$comment`, systemd `Description=` — including heredoc and YAML block
#     bodies of those keys, and alert `documentation` `content` heredocs.
#     These are documentation in all but syntax, and on several deployed
#     resources (a VPC's description, for one) editing them forces
#     replacement.
#   - Python docstrings: doc comments by another name.
#   - Vendored / generated trees: node_modules, lockfiles.
# cspell:ignore heredoc heredocs docstrings lstrip lastindex gecos lockfiles toplevel tfvars startswith endswith splitlines pipefail rsplit
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

git ls-files -z | python3 -c '
import re, sys

SUMMARY = (
    "Document numbers (SPEC/RDR/RCP-NNN, and AC/FR/NFR/OQ or gate ids used as names) stay out of code: name the "
    "thing, and put the spec reference in a comment.")

PATH_RE = re.compile(r"(?i)(spec|rdr|rcp)[_-]?[0-9]{3}")
TOKEN_RE = re.compile(r"(?i)(?<![a-z0-9])(spec|rdr|rcp)[_-]?[0-9]{3}(?![0-9])")
# Finer references used as names: an acceptance criterion, requirement or
# open question attached to a name (ac14_foo, foo_fr41, SHELLS-OQ9), a
# lower-case design gate key (g3_mrr_drop), and the same in a file name
# (reactions_fr41.rs, x.nfr14.json). UUIDs and long hex or base64 runs are
# removed before the content match, so a UUID fragment like -ac79 is not a
# criterion. Bare runbook numbers and task ids are not matched: in code
# they are almost always prose (alert documentation, a runbook path).
FINE_RE = re.compile(
    r"(?i:(?<![a-z0-9])(n?fr|ac|oq)[-_]?[0-9]{1,3}[a-z]?_[a-z]"
    r"|[a-z0-9][_-](n?fr|ac|oq)[-_]?[0-9]{1,3}[a-z]?(?![a-z0-9]))"
    r"|\bg[1-9]_[a-z_]{3,}")
FINE_PATH_RE = re.compile(r"(?i)[._-](n?fr|ac|oq|g)[0-9]{1,3}([._-]|$)")
NOISE_RE = re.compile(
    r"(?i)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
    r"|[0-9a-f]{8,}|[a-z0-9+/=]{40,}")
DOC_PREFIXES = ("docs/", "research/", "runbooks/", ".spec-workflow")
CODE_EXT = (".rs", ".dart", ".swift", ".kt", ".kts", ".py", ".sh", ".bash",
            ".toml", ".yaml", ".yml", ".json", ".tf", ".tfvars", ".hcl",
            ".ts", ".js", ".cjs", ".mjs", ".sql")
CODE_NAMES = ("justfile", "Justfile", "Dockerfile", "Makefile")
SKIP_PARTS = ("node_modules/",)
SKIP_NAMES = ("package-lock.json", "pnpm-lock.yaml", "uv.lock", "Cargo.lock")
LINE_COMMENT = ("///", "//", "#", "--", "/*", "*")
TRAILING = re.compile(r"(^|\s)(//|#|--)(\s|$)")
LABEL_EXEMPT = re.compile(
    r"(?i)(^|[{,\s])spec\s*=\s*\"spec-[0-9]{3}\"|^\s*(tags|topics)\s*=\s*\[|^\s*tag\s*=\s*\"spec-[0-9]{3}\"")
PROSE_KEY = (
    r"(\"?\$?(description|display_name|title|notes|comment|desc|gecos)"
    r"\"?|Description)")
PROSE_LINE = re.compile(r"^\s*-?\s*" + PROSE_KEY + r"\s*[:=]")
PROSE_HEREDOC = re.compile(
    r"^\s*(" + PROSE_KEY + r"|content)\s*=\s*<<-?\s*([A-Za-z_]+)\s*$")
YAML_BLOCK = re.compile(r"^(\s*)" + PROSE_KEY + r":\s*[>|][-+]?\s*$")
DOCSTRING_OPEN = re.compile(r"^\s*[rbuRBU]?(\"\"\"|\x27\x27\x27)")

# clap prints the doc comments of a derive as --help text, so in Rust those
# /// lines are output, not comments: the doc block above a
# #[derive(Parser|Subcommand|Args|ValueEnum)] and every /// in its body.
# There any document or criterion number fails, bare ones included.
CLAP_DERIVE = re.compile(r"#\[derive\([^)]*\b(Parser|Subcommand|Args|ValueEnum)\b")
HELP_RE = re.compile(
    r"(?i)(?<![a-z0-9])(spec|rdr|rcp|rb|n?fr|ac|oq)[-_ ]?[0-9]{1,3}[a-z]?(?![0-9])")


def clap_help_lines(lines):
    found = set()
    for i, line in enumerate(lines):
        if not CLAP_DERIVE.search(line):
            continue
        j = i - 1
        while j >= 0 and lines[j].strip().startswith(("//", "#[")):
            if lines[j].strip().startswith("///"):
                found.add(j)
            j -= 1
        depth, started = 0, False
        for k in range(i + 1, len(lines)):
            s = lines[k].strip()
            if s.startswith("///"):
                if started:
                    found.add(k)
                continue
            if s.startswith("//"):
                continue
            depth += s.count("{") - s.count("}")
            started = started or "{" in s
            if (started and depth <= 0) or (not started and s.endswith(";")):
                break
    return found


def is_doc(path):
    base = path.rsplit("/", 1)[-1]
    return (path.startswith(DOC_PREFIXES) or "/.spec-workflow" in path
            or base.startswith("CHANGELOG") or path.endswith(".md"))

def code_part(line):
    stripped = line.lstrip()
    if stripped.startswith(LINE_COMMENT):
        return ""
    m = TRAILING.search(line)
    return line[: m.start()] if m else line

failures = []
for path in sys.stdin.buffer.read().decode().split("\0"):
    if not path or is_doc(path):
        continue
    if PATH_RE.search(path) or FINE_PATH_RE.search(path.rsplit("/", 1)[-1]):
        failures.append(f"{path}: file name carries a document number")
    base = path.rsplit("/", 1)[-1]
    if any(p in path for p in SKIP_PARTS) or base in SKIP_NAMES:
        continue
    if not (path.endswith(CODE_EXT) or base in CODE_NAMES):
        continue
    try:
        text = open(path, encoding="utf-8").read()
    except (OSError, UnicodeDecodeError):
        continue
    is_py = path.endswith(".py")
    heredoc = None      # terminator of a prose heredoc being skipped
    yaml_indent = None  # indent of a prose YAML block scalar being skipped
    docstring = None    # quote of a Python docstring being skipped
    help = clap_help_lines(text.splitlines()) if path.endswith(".rs") and any(CLAP_DERIVE.search(x) for x in text.splitlines()) else set()
    for n, line in enumerate(text.splitlines(), 1):
        if heredoc is not None:
            if line.strip() == heredoc:
                heredoc = None
            continue
        if yaml_indent is not None:
            if not line.strip() or len(line) - len(line.lstrip()) > yaml_indent:
                continue
            yaml_indent = None
        if docstring is not None:
            if docstring in line:
                docstring = None
            continue
        if is_py:
            m = DOCSTRING_OPEN.match(line)
            if m:
                rest = line[m.end():]
                if m.group(1) not in rest:
                    docstring = m.group(1)
                continue
        m = PROSE_HEREDOC.match(line)
        if m:
            heredoc = m.group(m.lastindex)
            continue
        m = YAML_BLOCK.match(line)
        if m:
            yaml_indent = len(m.group(1))
            continue
        if ("allow-doc-number:" in line or LABEL_EXEMPT.search(line)
                or PROSE_LINE.match(line)):
            continue
        if n - 1 in help and HELP_RE.search(line.strip()[3:]):
            failures.append(f"{path}:{n}: clap help text: {line.strip()[:110]}")
            continue
        code = code_part(line)
        if TOKEN_RE.search(code) or FINE_RE.search(NOISE_RE.sub("", code)):
            failures.append(f"{path}:{n}: {line.strip()[:120]}")

if failures:
    print("\n".join(failures), file=sys.stderr)
    print(f"\n{len(failures)} violation(s). {SUMMARY}", file=sys.stderr)
    sys.exit(1)
'
