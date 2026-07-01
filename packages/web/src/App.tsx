const GITHUB_URL = import.meta.env.VITE_GITHUB_URL ?? 'https://github.com/your-username/sylo'
const MARKETPLACE_URL =
  import.meta.env.VITE_MARKETPLACE_URL ?? 'https://marketplace.visualstudio.com/items?itemName=sylo.sylo'

function HumanIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="1.5">
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21c0-4 3.5-6 8-6s8 2 8 6" strokeLinecap="round" />
    </svg>
  )
}

function RobotIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="1.5">
      <rect x="4" y="8" width="16" height="11" rx="2" />
      <path d="M12 4v4M8 13h.01M16 13h.01M9 16h6" strokeLinecap="round" />
    </svg>
  )
}

function Badge({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-full border border-border bg-surface px-3 py-1 text-xs text-ink/70">
      {children}
    </span>
  )
}

function Section({ id, children, className = '' }: { id?: string; children: React.ReactNode; className?: string }) {
  return (
    <section id={id} className={`mx-auto w-full max-w-5xl px-6 py-20 ${className}`}>
      {children}
    </section>
  )
}

function Hero() {
  return (
    <Section className="pt-28 text-center">
      <div className="mx-auto max-w-3xl">
        <h1 className="text-5xl font-bold tracking-tight sm:text-6xl">Your context. Always ready.</h1>
        <p className="mx-auto mt-6 max-w-2xl text-lg text-ink/70">
          Sylo captures your working state when you leave VS Code. Come back to a 3-sentence brief. Fire up
          Claude Code with a ready-made context file. Never explain yourself again.
        </p>
        <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
          <a
            href={MARKETPLACE_URL}
            className="rounded-md bg-accent px-5 py-3 font-medium text-white transition hover:brightness-110"
          >
            Install from VS Code Marketplace
          </a>
          <a
            href={GITHUB_URL}
            className="rounded-md border border-border px-5 py-3 font-medium text-ink transition hover:bg-surface"
          >
            View on GitHub
          </a>
        </div>
        <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
          <Badge>Free during beta</Badge>
          <Badge>No screen recording</Badge>
          <Badge>Your API key, your data</Badge>
        </div>
      </div>
    </Section>
  )
}

function DemoCard({
  eyebrow,
  icon,
  children
}: {
  eyebrow: string
  icon: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <div className="flex-1 rounded-xl border border-border bg-panel p-5">
      <div className="mb-4 flex items-center gap-2 text-accent">
        {icon}
        <span className="text-sm font-medium text-ink/80">{eyebrow}</span>
      </div>
      <div className="font-mono text-[13px] leading-relaxed text-ink/85">{children}</div>
    </div>
  )
}

function FeatureSplit() {
  return (
    <Section>
      <div className="flex flex-col gap-6 md:flex-row">
        <DemoCard eyebrow="For you" icon={<HumanIcon />}>
          <p className="mb-3 text-ink/50">When you come back</p>
          <p className="mb-3 text-ink/60">Back after 23 minutes</p>
          <p className="mb-3">
            You were debugging the token refresh race condition in{' '}
            <span className="text-accent">src/auth/middleware.ts</span>, specifically{' '}
            <span className="text-accent">refreshTokenIfExpired</span> on line 84.
          </p>
          <p className="mb-3">
            You had narrowed it to a missing mutex before the async/await on line 91.
          </p>
          <p className="mb-4">
            Add a try/finally block and run{' '}
            <span className="text-accent">npm test -- --grep "token refresh"</span>.
          </p>
          <button className="rounded border border-border bg-surface px-3 py-1 text-xs text-ink/80">
            ✓ Got it
          </button>
        </DemoCard>

        <DemoCard eyebrow="For your agent" icon={<RobotIcon />}>
          <p className="mb-3 text-ink/50">When you open Claude Code</p>
          <pre className="whitespace-pre-wrap break-words text-ink/85">
{`# Sylo Context — myproject
> Branch: fix/auth-race-condition

## What's being worked on
Fixing a race condition in token refresh
in src/auth/middleware.ts...

## Errors to address
ERROR [typescript]: Type 'undefined'
is not assignable to 'string'
in src/auth/types.ts:34

## Next action
Your first task is to add a mutex
lock around the refreshTokenIfExpired
call on line 91 of middleware.ts.`}
          </pre>
        </DemoCard>
      </div>
      <p className="mt-6 text-center text-sm text-ink/60">
        One keystroke. <span className="font-mono text-accent">Cmd+Shift+Alt+S</span>. Your agent has full
        context.
      </p>
    </Section>
  )
}

function HowItWorks() {
  const steps = [
    'Install Sylo and add your API key (30 seconds).',
    'Work normally. Sylo watches your editor state in the background.',
    'Come back from an interruption — see your 3-sentence re-entry brief automatically.',
    'Starting an agent session? Press Cmd+Shift+Alt+S. Sylo writes SYLO_CONTEXT.md and copies it to your clipboard. Paste it into Claude Code, Cursor, or any LLM.'
  ]
  return (
    <Section className="border-t border-border">
      <h2 className="text-center text-3xl font-semibold">How it works</h2>
      <ol className="mx-auto mt-10 grid max-w-4xl gap-5 sm:grid-cols-2">
        {steps.map((step, i) => (
          <li key={i} className="flex gap-4 rounded-lg border border-border bg-surface p-5">
            <span className="flex h-8 w-8 flex-none items-center justify-center rounded-full bg-accent/15 font-mono text-accent">
              {i + 1}
            </span>
            <span className="text-ink/80">{step}</span>
          </li>
        ))}
      </ol>
    </Section>
  )
}

function Integrations() {
  const agents = ['Claude Code', 'Cursor', 'GitHub Copilot', 'ChatGPT']
  return (
    <Section className="border-t border-border text-center">
      <h2 className="text-3xl font-semibold">Works with your agent</h2>
      <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
        {agents.map((a) => (
          <span
            key={a}
            className="rounded-lg border border-border bg-surface px-5 py-3 font-mono text-sm text-ink/80"
          >
            {a}
          </span>
        ))}
      </div>
      <p className="mt-6 text-sm text-ink/60">
        Sylo generates context files optimized for each agent's format.
      </p>
    </Section>
  )
}

function Privacy() {
  const points = [
    'Your code never leaves your machine (except to your own API).',
    'No screen recording, no keystroke logging, no clipboard access without your action.',
    'Sylo reads only open file metadata, cursor position, git diff, and error messages.',
    'The context snapshot goes directly from VS Code to your own API key — Sylo never sees it.',
    'SYLO_CONTEXT.md is automatically added to .gitignore.'
  ]
  return (
    <Section className="border-t border-border">
      <h2 className="text-center text-3xl font-semibold">Private by design</h2>
      <ul className="mx-auto mt-10 max-w-3xl space-y-3">
        {points.map((p) => (
          <li key={p} className="flex gap-3 text-ink/80">
            <span className="mt-1 flex-none text-accent">◆</span>
            <span>{p}</span>
          </li>
        ))}
      </ul>
    </Section>
  )
}

function WhoItsFor() {
  const audiences = [
    'On-call engineers who get paged and need to resume fast.',
    'Developers who use Claude Code, Cursor, or Copilot daily and waste time re-explaining their task.',
    'Contractors juggling multiple client codebases.',
    'Any developer who’s ever typed "so I’m working on X and the problem is Y" into an LLM for the fifth time this week.'
  ]
  return (
    <Section className="border-t border-border">
      <h2 className="text-center text-3xl font-semibold">Who it's for</h2>
      <div className="mx-auto mt-10 grid max-w-4xl gap-5 sm:grid-cols-2">
        {audiences.map((a) => (
          <div key={a} className="rounded-lg border border-border bg-surface p-5 text-ink/80">
            {a}
          </div>
        ))}
      </div>
    </Section>
  )
}

function Footer() {
  return (
    <footer className="border-t border-border">
      <div className="mx-auto flex max-w-5xl flex-col items-center gap-4 px-6 py-10 text-sm text-ink/60 sm:flex-row sm:justify-between">
        <span>MIT License</span>
        <div className="flex gap-5">
          <a className="hover:text-ink" href={GITHUB_URL}>
            GitHub
          </a>
          <a className="hover:text-ink" href="#privacy">
            Privacy
          </a>
        </div>
        <span className="text-center text-ink/50">
          Built so you never have to explain yourself to an agent again.
        </span>
      </div>
    </footer>
  )
}

export default function App() {
  return (
    <div className="min-h-screen bg-canvas text-ink">
      <Hero />
      <FeatureSplit />
      <HowItWorks />
      <Integrations />
      <div id="privacy">
        <Privacy />
      </div>
      <WhoItsFor />
      <Footer />
    </div>
  )
}
