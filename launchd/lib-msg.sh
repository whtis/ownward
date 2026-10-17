# Sourced by the install scripts: msg "<English>" "<中文>" prints one line in the user's language.
# Chinese when OWNWARD_LANG / LC_ALL / LC_MESSAGES / LANG starts with zh, or when the locale is
# unset, C/POSIX or en* and macOS's first preferred language is Chinese. OWNWARD_LANG=en forces English.
ownward_msg_lang() {
  local lang="${OWNWARD_LANG:-}"
  if [ -z "$lang" ]; then
    lang="${LC_ALL:-${LC_MESSAGES:-${LANG:-}}}"
    case "$lang" in
      zh*) ;;
      ""|C|C.*|POSIX|en*) lang="$(defaults read -g AppleLanguages 2>/dev/null | sed -n '2s/[^A-Za-z-]//gp' || true)" ;;
    esac
  fi
  case "$lang" in zh*) echo zh ;; *) echo en ;; esac
}
OWNWARD_MSG_LANG="$(ownward_msg_lang)"
msg() { if [ "$OWNWARD_MSG_LANG" = zh ]; then printf '%s\n' "$2"; else printf '%s\n' "$1"; fi; }
