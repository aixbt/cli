import { Command } from 'commander'

function getCompletions(program: Command): { commands: string[]; globalOptions: string[] } {
  const commands = program.commands.map(cmd => cmd.name()).filter(n => n !== 'completion')
  const globalOptions = program.options.map(opt => opt.long).filter(Boolean) as string[]
  return { commands, globalOptions }
}

function bashScript(binName: string, commands: string[], globalOptions: string[]): string {
  const cmds = commands.join(' ')
  const opts = globalOptions.join(' ')
  return `# bash completion for ${binName}
# Add to ~/.bashrc: eval "$(${binName} completion bash)"
_${binName}_completions() {
  local cur prev commands global_opts
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"
  commands="${cmds}"
  global_opts="${opts} -v -h --help --version"

  if [[ \${COMP_CWORD} -eq 1 ]]; then
    COMPREPLY=($(compgen -W "\${commands} \${global_opts}" -- "\${cur}"))
    return 0
  fi

  case "\${COMP_WORDS[1]}" in
    help)
      COMPREPLY=($(compgen -W "\${commands}" -- "\${cur}"))
      ;;
    *)
      if [[ "\${cur}" == -* ]]; then
        local cmd_help
        cmd_help="$(${binName} \${COMP_WORDS[1]} --help 2>/dev/null | grep -oE '\\-\\-[a-z][a-z-]*' | sort -u)"
        COMPREPLY=($(compgen -W "\${cmd_help} \${global_opts}" -- "\${cur}"))
      fi
      ;;
  esac
  return 0
}
complete -F _${binName}_completions ${binName}
`
}

function zshScript(binName: string, commands: string[], globalOptions: string[]): string {
  const cmds = commands.map(c => `'${c}'`).join(' ')
  const opts = globalOptions.join(' ')
  return `# zsh completion for ${binName}
# Add to ~/.zshrc: eval "$(${binName} completion zsh)"
_${binName}() {
  local -a commands global_opts
  commands=(${cmds})
  global_opts=(${opts} -v -h --help --version)

  if (( CURRENT == 2 )); then
    _describe 'commands' commands
    _describe 'options' global_opts
    return
  fi

  case "\${words[2]}" in
    help)
      _describe 'commands' commands
      ;;
    *)
      if [[ "\${words[CURRENT]}" == -* ]]; then
        local -a cmd_opts
        cmd_opts=(\${(f)"$(${binName} \${words[2]} --help 2>/dev/null | grep -oE '\\-\\-[a-z][a-z-]*' | sort -u)"})
        _describe 'options' cmd_opts
        _describe 'global' global_opts
      fi
      ;;
  esac
}
compdef _${binName} ${binName}
`
}

export function registerCompletionCommand(program: Command): void {
  program
    .command('completion [shell]')
    .description('Output shell completion script (bash or zsh)')
    .action((shell?: string) => {
      const detected = shell ?? (process.env.SHELL?.includes('zsh') ? 'zsh' : 'bash')
      const { commands, globalOptions } = getCompletions(program)

      if (detected === 'zsh') {
        process.stdout.write(zshScript('aixbt', commands, globalOptions))
      } else if (detected === 'bash') {
        process.stdout.write(bashScript('aixbt', commands, globalOptions))
      } else {
        console.error(`Unsupported shell: ${detected}. Use "bash" or "zsh".`)
        process.exit(1)
      }
    })
}
