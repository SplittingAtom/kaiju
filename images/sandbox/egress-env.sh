# Kaiju egress for the tools Pi runs (KOBE-39). Root-owned and read-only; Pi's environment names it
# in BASH_ENV, so every non-interactive bash (each bash tool call) sources it before the command.
#
# It reads the sandbox's current egress token from the file kaiju-sandbox-agent rotates
# (KAIJU_EGRESS_TOKEN_FILE) with the `read` builtin (no process, nothing in any argv or log) and
# exports the proxy variables curl, pip, npm, git and Python use:
#   HTTPS_PROXY=http://<thread id>:<token>@<egress proxy host:port>
# The thread id lets the proxy show a blocked request in this thread. Without a token file nothing
# is exported, and direct connections are refused by the sandbox's NetworkPolicy anyway.
# Only POSIX/bash builtins below: it runs before every command. Tracing (`bash -x`, whose output
# becomes the tool result) is paused while the token is handled, so it never shows in a trace.
# The tools' own HOME and TMPDIR (KOBE-228). With the executor off, Pi's HOME and TMPDIR are private
# to its thread (Pi loads code from both: ~/.node_modules, caches), so the agent names the shared
# ones in KAIJU_TOOL_HOME / KAIJU_TOOL_TMPDIR and every bash tool call switches to them here. Absolute
# paths on one line only (never build a path from anything else).
# KOBE-235: this block does not depend on egress. The agent names this script in BASH_ENV whenever
# the executor is off, with or without an egress proxy, so tools always get the shared HOME/TMPDIR.
# (Pi's own file tools resolve `~` against Pi's private HOME, not these: see docs/ledger/KOBE-235.md.)
case "${KAIJU_TOOL_HOME:-}" in /*) case "$KAIJU_TOOL_HOME" in *[!A-Za-z0-9._/-]*) ;; *) export HOME="$KAIJU_TOOL_HOME" ;; esac ;; esac
case "${KAIJU_TOOL_TMPDIR:-}" in /*) case "$KAIJU_TOOL_TMPDIR" in *[!A-Za-z0-9._/-]*) ;; *) export TMPDIR="$KAIJU_TOOL_TMPDIR" ;; esac ;; esac
case "$-" in *x*) __kaiju_egress_xtrace=1; set +x ;; *) __kaiju_egress_xtrace="" ;; esac
if [ -n "${KAIJU_EGRESS_TOKEN_FILE:-}" ] && [ -n "${KAIJU_EGRESS_PROXY:-}" ] && [ ! -r "$KAIJU_EGRESS_TOKEN_FILE" ]; then
  # Say why internet access will fail instead of failing silently (one line, on stderr).
  printf '%s\n' "kaiju: the sandbox's egress token is not readable; internet access through the egress proxy is unavailable" >&2
elif [ -n "${KAIJU_EGRESS_TOKEN_FILE:-}" ] && [ -n "${KAIJU_EGRESS_PROXY:-}" ]; then
  __kaiju_egress_token=""
  IFS= read -r __kaiju_egress_token < "$KAIJU_EGRESS_TOKEN_FILE" || true
  __kaiju_egress_user="${KAIJU_THREAD_ID:-kaiju}"
  __kaiju_egress_host="${KAIJU_EGRESS_PROXY#http://}"
  __kaiju_egress_host="${__kaiju_egress_host%/}"
  case "$__kaiju_egress_token$__kaiju_egress_user$__kaiju_egress_host" in
    *[!A-Za-z0-9._:-]* | "") # anything unexpected: export nothing (never build a URL from it)
      printf '%s\n' "kaiju: the sandbox's egress token file is malformed; internet access through the egress proxy is unavailable" >&2
      ;;
    *)
      if [ -n "$__kaiju_egress_token" ]; then
        __kaiju_egress_url="http://${__kaiju_egress_user}:${__kaiju_egress_token}@${__kaiju_egress_host}"
        export HTTPS_PROXY="$__kaiju_egress_url" https_proxy="$__kaiju_egress_url"
        export HTTP_PROXY="$__kaiju_egress_url" http_proxy="$__kaiju_egress_url"
      fi
      ;;
  esac
  unset __kaiju_egress_token __kaiju_egress_user __kaiju_egress_host __kaiju_egress_url
fi
if [ -n "$__kaiju_egress_xtrace" ]; then unset __kaiju_egress_xtrace; set -x; else unset __kaiju_egress_xtrace; fi
