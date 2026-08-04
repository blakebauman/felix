/**
 * Shell-aware normalization of a command string, so pattern rules match what a
 * shell will actually RUN rather than the literal text the model emitted.
 *
 * Matching a regex against a raw command string is trivially evadable. Every
 * one of these runs `rm -rf /` but defeats a naive `\brm\b.*-rf` rule:
 *
 *     r"m" -rf /                     quote splitting
 *     $'\x72m' -rf /                 ANSI-C escapes
 *     bash -c 'rm -rf /'             nested interpreter
 *     eval "rm -rf /"                eval
 *     echo 'rm -rf /' | sh           pipe-to-shell
 *     sh <<< 'rm -rf /'              here-string
 *     X=rm; $X -rf /                 variable indirection
 *     sudo -u root rm -rf /          wrapper chain
 *     env -S 'rm -rf /'              split-string
 *
 * `scannableCommand` produces a normalized projection: the command with
 * quoting/escapes resolved, plus every payload that will itself be executed
 * appended on its own line (recursively, to a bounded depth). Rules are then
 * matched against that projection, so all of the above hit the same rule.
 *
 * Scope, stated plainly: this raises the cost of evasion, it is not a sandbox
 * boundary. A determined agent can still defeat it with base64-then-decode,
 * writing a script file and running it later, or fetching a payload at
 * runtime. Treat it as defense in depth over an isolated execution
 * environment, never as the only thing standing between a model and the host.
 */

/** Bound on recursive unwrapping — an interpreter nested this deep is pathological. */
const MAX_SCAN_DEPTH = 8;

/** Interpreters whose `-c` argument (or stdin) is executed as shell source. */
const SHELLS = ['bash', 'sh', 'dash', 'zsh', 'ksh'];

/**
 * Wrappers that run another command, mapped to the options that take a
 * SEPARATE value argument. Getting this arity right is what lets
 * `sudo -u root rm -rf /` resolve to `rm -rf /` instead of stopping at `root`.
 */
const WRAPPER_VALUE_OPTIONS: Record<string, Set<string>> = {
  env: new Set(['-u', '--unset', '-C', '--chdir', '-S', '--split-string']),
  command: new Set(),
  builtin: new Set(),
  exec: new Set(['-a']),
  sudo: new Set([
    '-u',
    '--user',
    '-g',
    '--group',
    '-h',
    '--host',
    '-p',
    '--prompt',
    '-C',
    '--chdir',
    '-T',
    '--command-timeout',
    '-R',
    '--chroot',
    '-t',
    '--type',
  ]),
  nice: new Set(['-n', '--adjustment']),
  timeout: new Set(['-s', '--signal', '-k', '--kill-after']),
  time: new Set(['-o', '--output', '-f', '--format']),
  nohup: new Set(),
  stdbuf: new Set(['-i', '--input', '-o', '--output', '-e', '--error']),
  coproc: new Set(),
  xargs: new Set([
    '-a',
    '--arg-file',
    '-d',
    '--delimiter',
    '-E',
    '--eof',
    '-I',
    '--replace',
    '-L',
    '--max-lines',
    '-n',
    '--max-args',
    '-P',
    '--max-procs',
    '-s',
    '--max-chars',
  ]),
};

/** Script paths that mean "read the program from stdin". */
const STDIN_SCRIPTS = new Set(['-', '/dev/stdin', '/dev/fd/0', '/proc/self/fd/0']);

/**
 * Normalize `command` into the string that rules are matched against.
 *
 * The result is the de-quoted command, followed by one line per executed
 * payload discovered inside it (each itself normalized). Rules should be
 * written to match a single line; the projection is newline-joined so `^`/`$`
 * anchors behave per payload under the `m`-less default the evaluator uses.
 */
export function scannableCommand(command: string): string {
  return scanAtDepth(command, 0);
}

function scanAtDepth(command: string, depth: number): string {
  const stripped = stripWrittenHeredocs(command);

  // De-quote so `r"m"` reads as `rm`. A quoted run that ISN'T a plain bare word
  // is not spliced into the surrounding text — that would let `"; rm -rf /"`
  // sitting inside an inert argument fuse with its neighbours and fabricate a
  // match. Instead it is emitted on its own line, so rules can still see the
  // content (`psql -c "DROP TABLE users"` must match a destructive-SQL rule)
  // without it fusing with adjacent tokens. Dropping the text outright, the
  // other obvious option, silently blinds every rule to quoted payloads.
  const quoted: string[] = [];
  const keep = (inner: string): string | undefined => {
    const bare = unquoteBareWord(inner);
    if (bare !== undefined) return bare;
    if (inner.trim()) quoted.push(inner);
    return undefined;
  };

  const base = stripped
    .replace(/"(?:[^"\\]|\\.)*"/g, (m) => {
      // A double-quoted run still expands `$(…)` / backticks — preserve those
      // so the recursion below can find the nested command.
      const subs = m.match(/\$\([^)]*\)|`[^`]*`/g);
      if (subs) return subs.join(' ');
      return keep(m.slice(1, -1)) ?? '""';
    })
    .replace(/\$'((?:[^'\\]|\\.)*)'/g, (_m, inner: string) => keep(decodeAnsiC(inner)) ?? "''")
    .replace(/'[^']*'/g, (m) => keep(m.slice(1, -1)) ?? "''")
    .replace(/\\([\w@%+=:,./-])/g, '$1');

  const lines = [base, ...quoted];
  if (depth >= MAX_SCAN_DEPTH) return lines.join('\n');

  const executed = executedShellPayloads(stripped);
  if (!executed.length) return lines.join('\n');
  return [...lines, ...executed.map((payload) => scanAtDepth(payload, depth + 1))].join('\n');
}

/**
 * Drop heredoc bodies that are being WRITTEN to a file rather than executed.
 *
 * `cat <<EOF > notes.txt … EOF` is data, and scanning it produces false
 * positives on any document that happens to discuss `rm -rf`. A heredoc fed to
 * a shell (`bash <<EOF … EOF`) is kept — that body really does run.
 */
function stripWrittenHeredocs(command: string): string {
  return command.replace(
    /^([^\n]*)<<-?\s*(["']?)([A-Za-z_]\w*)\2([^\n]*)\n([\s\S]*?)^\s*\3\s*$/gm,
    (full, pre: string, _q: string, _delim: string, post: string) =>
      /[>]/.test(pre + post) && !heredocRunsShell(pre + post) ? '' : full,
  );
}

/** True when the command line receiving a heredoc will execute it as shell source. */
function heredocRunsShell(commandLine: string): boolean {
  const shells = /(?:^|[|;&]\s*)(?:\S*\/)?(?:ba|da|k|z)?sh((?:\s+[^|;&]*)?)/g;
  // A `-c` form takes its program from the argument, so the heredoc is data.
  return [...commandLine.matchAll(shells)].some(
    (match) => !/(?:^|\s)-[^-\s]*c(?:\s|$)/.test(match[1] ?? ''),
  );
}

/** Resolve `$'…'` escape sequences the way bash does. */
function decodeAnsiC(value: string): string {
  return value
    .replace(/\\x([0-9a-fA-F]{1,2})/g, (_, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/\\U([0-9a-fA-F]{8})/g, (_, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/\\([0-7]{1,3})/g, (_, octal: string) =>
      String.fromCodePoint(Number.parseInt(octal, 8)),
    )
    .replace(
      /\\([\\'"abefnrtv])/g,
      (_, code: string) =>
        ({ a: '\x07', b: '\b', e: '\x1b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v' })[code] ??
        code,
    );
}

/**
 * Return `inner` when it is a plain word (so unquoting it is faithful), else
 * undefined so the caller collapses the quoted run instead.
 */
function unquoteBareWord(inner: string): string | undefined {
  return /^[\w@%+=:,./-]*$/.test(inner) ? inner : undefined;
}

interface ShellScan {
  /** Word-split simple commands, one array per command. */
  commands: string[][];
  /** Bodies of `$(…)` / backtick substitutions — each is executed. */
  nested: string[];
}

/**
 * Word-split the input the way a shell would: honoring quoting, escapes, and
 * command substitution, and breaking on `; | & ( ) { }` and newlines.
 *
 * This is deliberately a tokenizer, not a parser — it needs to find executables
 * and their arguments, not build an AST.
 */
function scanShell(input: string): ShellScan {
  const commands: string[][] = [];
  const nested: string[] = [];
  let words: string[] = [];
  let i = 0;

  const flush = () => {
    if (words.length > 0) commands.push(words);
    words = [];
  };

  // Find the matching `)` of a `$(` at `start`, tracking nesting and quotes.
  const commandSubstitution = (start: number): { body: string; end: number } | undefined => {
    let depth = 1;
    let quote = '';
    for (let j = start + 2; j < input.length; j++) {
      const c = input.charAt(j);
      if (c === '\\') {
        j++;
        continue;
      }
      if (quote) {
        if (c === quote) quote = '';
        continue;
      }
      if (c === "'" || c === '"') {
        quote = c;
        continue;
      }
      if (c === '$' && input.charAt(j + 1) === '(') {
        depth++;
        j++;
      } else if (c === ')' && --depth === 0) {
        return { body: input.slice(start + 2, j), end: j + 1 };
      }
    }
    return undefined;
  };

  while (i < input.length) {
    if (/\s/.test(input.charAt(i))) {
      if (input.charAt(i) === '\n') flush();
      i++;
      continue;
    }
    if (input.charAt(i) === '#' && words.length === 0) {
      while (i < input.length && input.charAt(i) !== '\n') i++;
      continue;
    }
    if (';|&(){}'.includes(input.charAt(i))) {
      flush();
      while (i < input.length && ';|&(){}'.includes(input.charAt(i))) i++;
      continue;
    }

    let word = '';
    let wordStarted = false;
    while (
      i < input.length &&
      !/\s/.test(input.charAt(i)) &&
      // `2>&1` keeps its `&` attached to the redirection operator.
      (!';|&(){}'.includes(input.charAt(i)) || (input.charAt(i) === '&' && /[<>]$/.test(word)))
    ) {
      const c = input.charAt(i);
      if (c === '\\') {
        if (input.charAt(i + 1) === '\n') i += 2;
        else if (i + 1 < input.length) {
          wordStarted = true;
          word += input.charAt(i + 1);
          i += 2;
        } else i++;
        continue;
      }
      if (c === "'") {
        wordStarted = true;
        const end = input.indexOf("'", i + 1);
        if (end < 0) {
          word += input.slice(i + 1);
          i = input.length;
        } else {
          word += input.slice(i + 1, end);
          i = end + 1;
        }
        continue;
      }
      if (c === '$' && input.charAt(i + 1) === "'") {
        wordStarted = true;
        const end = input.indexOf("'", i + 2);
        if (end < 0) {
          word += input.slice(i + 2);
          i = input.length;
        } else {
          word += decodeAnsiC(input.slice(i + 2, end));
          i = end + 1;
        }
        continue;
      }
      if (c === '"') {
        wordStarted = true;
        i++;
        while (i < input.length && input.charAt(i) !== '"') {
          if (input.charAt(i) === '\\' && i + 1 < input.length) {
            word += input.charAt(i + 1);
            i += 2;
          } else if (input.charAt(i) === '$' && input.charAt(i + 1) === '(') {
            const sub = commandSubstitution(i);
            if (!sub) word += input.charAt(i++);
            else {
              nested.push(sub.body);
              i = sub.end;
            }
          } else if (input.charAt(i) === '`') {
            const end = input.indexOf('`', i + 1);
            if (end < 0) i++;
            else {
              nested.push(input.slice(i + 1, end));
              i = end + 1;
            }
          } else word += input.charAt(i++);
        }
        if (input.charAt(i) === '"') i++;
        continue;
      }
      if (c === '$' && input.charAt(i + 1) === '(') {
        wordStarted = true;
        const sub = commandSubstitution(i);
        if (!sub) word += input.charAt(i++);
        else {
          nested.push(sub.body);
          i = sub.end;
        }
        continue;
      }
      // `${NAME}` is one word, not a `$` followed by a `{` block delimiter —
      // without this the brace-form of variable indirection (`X=rm; ${X} -rf /`)
      // tokenizes into fragments and slips past the indirection resolver.
      if (c === '$' && input.charAt(i + 1) === '{') {
        const end = input.indexOf('}', i + 2);
        if (end >= 0) {
          wordStarted = true;
          word += input.slice(i, end + 1);
          i = end + 1;
          continue;
        }
      }
      if (c === '`') {
        wordStarted = true;
        const end = input.indexOf('`', i + 1);
        if (end < 0) i++;
        else {
          nested.push(input.slice(i + 1, end));
          i = end + 1;
        }
        continue;
      }
      word += c;
      wordStarted = true;
      i++;
    }
    if (wordStarted) words.push(word);
  }
  flush();
  return { commands, nested };
}

/**
 * Index of the actual executable in a word list, skipping leading `VAR=value`
 * assignments, shell keywords, and redirections.
 */
function commandStart(words: string[]): number {
  let i = 0;
  while (i < words.length) {
    const word = words[i]!;
    if (/^[A-Za-z_]\w*=/.test(word) || /^(?:if|then|elif|else|while|until|do|!)$/.test(word)) i++;
    else if (/^\d*(?:>>?|<<?|<>|>&|<&)$/.test(word)) i += 2;
    else if (/^\d*(?:>>?|<<?|<>|>&|<&).+/.test(word)) i++;
    else break;
  }
  return i;
}

/**
 * Index of the first non-option argument, honoring which options consume a
 * separate value and stopping at an explicit `--`.
 */
function optionCommand(words: string[], start: number, valueOptions: Set<string>): number {
  let i = start;
  for (; i < words.length; i++) {
    const word = words[i]!;
    if (word === '--') return i + 1;
    if (!word.startsWith('-') || word === '-') return i;
    const name = word.replace(/=.*/, '');
    if (valueOptions.has(name) && !word.includes('=')) i++;
  }
  return i;
}

/** Extract the program text from `env -S '…'` / `--split-string=…` plus its trailing args. */
function splitStringPayload(
  args: string[],
  split: number,
): { value: string | undefined; rest: string[] } {
  const arg = args[split]!;
  const compact = arg.startsWith('-S') && arg.length > 2;
  let value = args[split + 1];
  if (arg.includes('=')) value = arg.slice(arg.indexOf('=') + 1);
  else if (compact) value = arg.slice(2);
  const rest = args.slice(split + (arg.includes('=') || compact ? 1 : 2));
  return { value, rest };
}

function envSplitIndex(args: string[]): number {
  return args.findIndex(
    (arg) =>
      arg === '-S' ||
      arg.startsWith('-S') ||
      arg === '--split-string' ||
      arg.startsWith('--split-string='),
  );
}

/** `env -S 'rm -rf /'` — the split string is re-tokenized as a command line. */
function envSplitWords(args: string[]): string[] | undefined {
  const split = envSplitIndex(args);
  if (split < 0) return undefined;
  const { value, rest } = splitStringPayload(args, split);
  if (value === undefined) return [];
  return scanShell([value, ...rest].join(' ')).commands[0] ?? [];
}

/**
 * Strip one layer of command wrapper (`sudo`, `env`, `timeout`, …) and return
 * the inner command's words. Returns null when the executable isn't a wrapper,
 * or when the invocation doesn't actually exec (e.g. `command -v`).
 *
 * One shared unwrapper keeps the option-arity table in a single place — every
 * caller below that walks a wrapper chain uses it, so a missing option in the
 * table can't produce inconsistent results between the "does this consume
 * stdin" check and the "what payload does this execute" check.
 */
function unwrapWrapper(words: string[]): string[] | null {
  const start = commandStart(words);
  if (start >= words.length) return null;
  const executableWord = words[start]!;
  const executable = executableWord.split('/').pop() ?? executableWord;
  const args = words.slice(start + 1);

  const valueOptions = WRAPPER_VALUE_OPTIONS[executable];
  if (!valueOptions) return null;

  if (executable === 'command') {
    // `-v` / `-V` print a resolution instead of running anything.
    for (let next = 0; next < args.length; next++) {
      if (args[next] === '--') return args.slice(next + 1);
      if (args[next] === '-v' || args[next] === '-V') return null;
      if (args[next] !== '-p') return args.slice(next);
    }
    return [];
  }
  if (executable === 'builtin') {
    if (args[0]?.startsWith('-') && args[0] !== '--') return null;
    return args[0] === '--' ? args.slice(1) : args;
  }
  if (executable === 'env') {
    const split = envSplitWords(args);
    if (split) return split;
    let next = optionCommand(args, 0, valueOptions);
    while (next < args.length && /^[A-Za-z_]\w*=/.test(args[next]!)) next++;
    return args.slice(next);
  }
  if (executable === 'timeout') {
    // The duration is a positional argument, not an option value.
    return args.slice(optionCommand(args, 0, valueOptions) + 1);
  }
  if (executable === 'coproc') return args;
  return args.slice(optionCommand(args, 0, valueOptions));
}

/**
 * True when this segment reads its PROGRAM from stdin — the consumer half of
 * `echo 'rm -rf /' | sh`. A `-c` form does not (its program is the argument).
 */
function segmentConsumesShellStdin(words: string[]): boolean {
  const start = commandStart(words);
  if (start >= words.length) return false;
  const executableWord = words[start]!;
  const executable = executableWord.split('/').pop() ?? executableWord;
  const args = words.slice(start + 1);

  if (SHELLS.includes(executable)) {
    for (let i = 0; i < args.length; i++) {
      const arg = args[i]!;
      if (/^-[^-]*c/.test(arg)) return false;
      if (arg === '-s') return true;
      if (['-O', '-o', '--rcfile', '--init-file'].includes(arg)) {
        i++;
        continue;
      }
      if (arg === '--') return args[i + 1] === undefined || STDIN_SCRIPTS.has(args[i + 1]!);
      if (!arg.startsWith('-') || arg === '-') return STDIN_SCRIPTS.has(arg);
    }
    // A bare `sh` with no script argument reads stdin.
    return true;
  }

  const inner = unwrapWrapper(words);
  return inner ? segmentConsumesShellStdin(inner) : false;
}

/**
 * Reconstruct the literal text a producer emits, for the `echo … | sh` shape.
 * Only literal producers are resolved — anything dynamic is left alone rather
 * than guessed at.
 */
function literalProducerPayload(words: string[]): string | undefined {
  const start = commandStart(words);
  if (start >= words.length) return undefined;
  const executableWord = words[start]!;
  const executable = executableWord.split('/').pop() ?? executableWord;

  if (WRAPPER_VALUE_OPTIONS[executable]) {
    const inner = unwrapWrapper(words);
    return inner ? literalProducerPayload(inner) : undefined;
  }

  let args = words.slice(start + 1);
  if (args[0] === '--') args = args.slice(1);

  if (executable === 'echo') {
    let decodeEscapes = false;
    while (/^-[neE]+$/.test(args[0] ?? '')) {
      for (const option of args[0]!.slice(1)) {
        if (option === 'e') decodeEscapes = true;
        if (option === 'E') decodeEscapes = false;
      }
      args = args.slice(1);
    }
    const payload = args.join(' ');
    return decodeEscapes ? decodeAnsiC(payload) : payload;
  }

  if (executable !== 'printf' || args.length === 0) return undefined;
  const [format, ...values] = args;
  let valueIndex = 0;
  const rendered = decodeAnsiC(format!).replace(/%([%sb])/g, (_match, conversion: string) => {
    if (conversion === '%') return '%';
    const value = values[valueIndex++] ?? '';
    return conversion === 'b' ? decodeAnsiC(value) : value;
  });
  // Include the unconsumed values and the raw argument text too: printf reuses
  // its format string when given extra arguments, and a rule should match the
  // payload however the arguments line up.
  return [rendered, ...values.slice(valueIndex), args.join(' ')].join('\n');
}

/** Split into pipelines of segments, quote-aware, so `|` inside a string isn't a pipe. */
function shellPipelines(input: string): string[][] {
  const pipelines: string[][] = [];
  let pipeline: string[] = [];
  let start = 0;
  let quote = '';

  const finishSegment = (end: number) => {
    const segment = input.slice(start, end).trim();
    if (segment) pipeline.push(segment);
  };
  const finishPipeline = (end: number) => {
    finishSegment(end);
    if (pipeline.length > 1) pipelines.push(pipeline);
    pipeline = [];
  };

  for (let i = 0; i < input.length; i++) {
    const char = input.charAt(i);
    if (char === '\\') {
      i++;
      continue;
    }
    if (quote) {
      if (char === quote) quote = '';
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      continue;
    }
    if ((char === '|' || char === '&') && input.charAt(i + 1) === char) {
      finishPipeline(i);
      i++;
      start = i + 1;
      continue;
    }
    if (char === '|') {
      finishSegment(i);
      if (input.charAt(i + 1) === '&') i++;
      start = i + 1;
      continue;
    }
    if (char === ';' || char === '\n' || char === '&') {
      finishPipeline(i);
      start = i + 1;
    }
  }
  finishPipeline(input.length);
  return pipelines;
}

/** `echo 'rm -rf /' | sh` — the producer's literal text is executed by the consumer. */
function pipedShellPayloads(input: string): string[] {
  const payloads: string[] = [];
  for (const pipeline of shellPipelines(input)) {
    for (let i = 1; i < pipeline.length; i++) {
      const consumer = scanShell(pipeline[i]!).commands[0];
      if (!consumer || !segmentConsumesShellStdin(consumer)) continue;
      const producer = scanShell(pipeline[i - 1]!).commands.at(-1);
      if (!producer) continue;
      const payload = literalProducerPayload(producer);
      if (payload) payloads.push(payload);
    }
  }
  return payloads;
}

/** `sh <<< 'rm -rf /'` — the here-string is the program. */
function hereStringShellPayloads(input: string): string[] {
  const payloads: string[] = [];
  // Space out `<<<` so the tokenizer emits it as its own word.
  let spaced = '';
  let quote = '';
  for (let i = 0; i < input.length; i++) {
    const char = input.charAt(i);
    if (char === '\\') {
      spaced += input.slice(i, i + 2);
      i++;
      continue;
    }
    if (quote) {
      spaced += char;
      if (char === quote) quote = '';
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      spaced += char;
      continue;
    }
    if (input.startsWith('<<<', i)) {
      spaced += ' <<< ';
      i += 2;
      continue;
    }
    spaced += char;
  }
  for (const words of scanShell(spaced).commands) {
    const redirect = words.indexOf('<<<');
    if (redirect <= 0 || !segmentConsumesShellStdin(words.slice(0, redirect))) continue;
    const payload = words[redirect + 1];
    if (payload) payloads.push(payload);
  }
  return payloads;
}

/**
 * Resolve single-level variable indirection at the executable position:
 * `X=curl; $X … | sh` becomes `curl … | sh`. Deeper chains are out of scope —
 * the recursion bound and the "not a sandbox boundary" caveat both apply.
 */
function simpleVariablePayloads(input: string): string[] {
  const values = new Map<string, string>();
  const payloads: string[] = [];

  const rememberAssignment = (word: string) => {
    const match = /^([A-Za-z_]\w*)=([\w./-]+)$/.exec(word);
    if (match) values.set(match[1]!, match[2]!);
  };

  for (const words of scanShell(input).commands) {
    // Leading `VAR=value` words are assignments whether or not a command
    // follows them (`X=rm cmd` and a bare `X=rm` both define X).
    const start = commandStart(words);
    for (let i = 0; i < start; i++) rememberAssignment(words[i]!);
    if (start >= words.length) {
      for (const word of words) rememberAssignment(word);
      continue;
    }

    // Substitute at EVERY position, not just the executable. `X=-rf; rm $X /`
    // hides the dangerous part in an argument, and is a simpler evasion than
    // moving the executable itself into a variable.
    let substituted = false;
    const resolved = words.map((word) => {
      const match = /^\$(?:\{([A-Za-z_]\w*)\}|([A-Za-z_]\w*))$/.exec(word);
      if (!match) return word;
      const value = values.get(match[1] ?? match[2] ?? '');
      if (value === undefined) return word;
      substituted = true;
      return value;
    });
    if (substituted) payloads.push(resolved.join(' '));
  }
  return payloads;
}

/** Program text passed to an interpreter: `bash -c '…'`, `eval …`, through wrapper chains. */
function segmentShellPayloads(words: string[]): string[] {
  const start = commandStart(words);
  if (start >= words.length) return [];
  const executableWord = words[start]!;
  const executable = executableWord.split('/').pop() ?? executableWord;
  const args = words.slice(start + 1);

  if (SHELLS.includes(executable)) {
    for (let j = 0; j < args.length; j++) {
      if (args[j] === '--' || !args[j]!.startsWith('-')) return [];
      if (['-O', '-o', '--rcfile', '--init-file'].includes(args[j]!)) {
        j++;
        continue;
      }
      if (/^-[^-]*c/.test(args[j]!)) return args[j + 1] === undefined ? [] : [args[j + 1]!];
    }
    return [];
  }
  if (executable === 'eval') return args.length ? [args.join(' ')] : [];
  if (executable === 'env') {
    const split = envSplitIndex(args);
    if (split >= 0) {
      const { value, rest } = splitStringPayload(args, split);
      return value === undefined ? [] : [[value, ...rest].join(' ')];
    }
  }

  const inner = unwrapWrapper(words);
  return inner ? segmentShellPayloads(inner) : [];
}

/** Every payload inside `input` that will itself be executed. */
function executedShellPayloads(input: string): string[] {
  const scan = scanShell(input);
  return [
    ...scan.nested,
    ...scan.commands.flatMap(segmentShellPayloads),
    ...pipedShellPayloads(input),
    ...hereStringShellPayloads(input),
    ...simpleVariablePayloads(input),
  ];
}
