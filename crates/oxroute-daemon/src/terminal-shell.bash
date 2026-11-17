# Follow terminals use normal interactive Bash execution, with readline saving the draft.
[[ ! -f ~/.bashrc ]] || source ~/.bashrc
# Readline callbacks use builtin read: command substitution can disturb Bash's parser.
__oxroute_stage() {
    __oxroute_status_before=$?
    __oxroute_point=$READLINE_POINT
    IFS= read -r __oxroute_id < "$OXROUTE_SHELL/request" || :
    __oxroute_active=1
    # A nonempty kill-ring entry also preserves an empty draft.
    READLINE_LINE=" $READLINE_LINE"
}
__oxroute_load() {
    IFS= read -r -d '' READLINE_LINE < "$OXROUTE_SHELL/$__oxroute_id.command" || :
    READLINE_POINT=${#READLINE_LINE}
    return "$__oxroute_status_before"
}
__oxroute_capture() {
    local __oxroute_status=$?
    builtin printf '%s' "$PWD" > "$OXROUTE_SHELL/cwd"
    if [[ ${__oxroute_active:-0} == 1 ]]; then
        builtin printf '%s\n' "$__oxroute_status" > "$OXROUTE_SHELL/$__oxroute_id.tmp"
    else
        builtin printf '' > "$OXROUTE_SHELL/ready"
    fi
    return "$__oxroute_status"
}
__oxroute_complete() {
    local __oxroute_status
    IFS= read -r __oxroute_status < "$OXROUTE_SHELL/$__oxroute_id.tmp"
    READLINE_POINT=$__oxroute_point
    __oxroute_active=0
    builtin printf '' > "$OXROUTE_SHELL/ready"
    command mv -- "$OXROUTE_SHELL/$__oxroute_id.tmp" "$OXROUTE_SHELL/$__oxroute_id.done"
    return "$__oxroute_status"
}
PROMPT_COMMAND=(__oxroute_capture "${PROMPT_COMMAND[@]}")
for __oxroute_map in emacs-standard vi-insert vi-command; do
    bind -m "$__oxroute_map" -x '"\e[98~":__oxroute_stage'
    bind -m "$__oxroute_map" -x '"\e[97~":__oxroute_load'
    bind -m "$__oxroute_map" -x '"\e[96~":__oxroute_complete'
    bind -m "$__oxroute_map" '"\e[95~":beginning-of-line'
    bind -m "$__oxroute_map" '"\e[94~":kill-line'
    bind -m "$__oxroute_map" '"\e[93~":accept-line'
    bind -m "$__oxroute_map" '"\e[92~":yank'
    bind -m "$__oxroute_map" '"\e[91~":delete-char'
    bind -m "$__oxroute_map" '"\e[99~":"\e[98~\e[95~\e[94~\e[97~\e[93~\e[92~\e[95~\e[91~\e[96~"'
done
unset __oxroute_map
