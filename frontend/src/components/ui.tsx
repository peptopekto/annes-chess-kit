import clsx from 'clsx'
import { animate, AnimatePresence, motion, useMotionValue, useTransform } from 'motion/react'
import { useEffect, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { X } from 'lucide-react'

type Variant = 'primary' | 'ghost' | 'soft' | 'danger'

export function Button({ variant = 'soft', size = 'md', className, children, ...rest }:
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md' | 'lg' }) {
  return (
    <button
      className={clsx(
        'inline-flex shrink-0 items-center justify-center gap-2 rounded-[10px] font-medium tracking-[-0.01em] whitespace-nowrap',
        'transition-[background-color,box-shadow,color,transform,filter] duration-150 ease-out',
        'active:scale-[0.98] disabled:pointer-events-none disabled:opacity-40 cursor-pointer',
        size === 'sm' && 'h-8 px-3 text-[13px]',
        size === 'md' && 'h-9 px-3.5 text-sm',
        size === 'lg' && 'h-11 px-5 text-[15px]',
        variant === 'primary' && 'bg-accent text-ink-950 font-semibold shadow-[inset_0_1px_0_rgba(255,255,255,.45),0_1px_2px_rgba(0,0,0,.4),0_8px_20px_-10px_rgba(46,230,209,.6)] hover:brightness-[1.08]',
        variant === 'soft' && 'bg-white/[0.06] text-ink-100 ring-1 ring-inset ring-white/[0.08] shadow-[inset_0_1px_0_rgba(255,255,255,.04)] hover:bg-white/[0.1] hover:text-white',
        variant === 'ghost' && 'text-ink-300 hover:bg-white/[0.06] hover:text-white',
        variant === 'danger' && 'bg-blunder/12 text-[#ff8796] ring-1 ring-inset ring-blunder/30 hover:bg-blunder/20',
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  )
}

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={clsx('glass rounded-2xl', className)}>{children}</div>
}

export function Segmented<T extends string | number>({ value, options, onChange, className }:
  { value: T; options: { value: T; label: ReactNode }[]; onChange: (v: T) => void; className?: string }) {
  return (
    <div className={clsx('relative inline-flex rounded-[11px] bg-black/25 p-[3px] ring-1 ring-inset ring-white/[0.07]', className)}>
      {options.map(o => (
        <button key={String(o.value)} onClick={() => onChange(o.value)}
          className={clsx('relative z-10 flex h-[30px] items-center gap-1.5 rounded-lg px-3 text-[13px] font-medium transition-colors cursor-pointer',
            o.value === value ? 'text-white' : 'text-ink-400 hover:text-ink-100')}>
          {o.value === value && (
            <motion.span layoutId={`seg-${options.map(x => x.value).join()}`}
              className="absolute inset-0 -z-10 rounded-lg bg-ink-600 shadow-[inset_0_1px_0_rgba(255,255,255,.08),0_1px_3px_rgba(0,0,0,.5)]"
              transition={{ type: 'spring', stiffness: 500, damping: 35 }} />
          )}
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function Spinner({ size = 18 }: { size?: number }) {
  return (
    <span className="inline-block shrink-0 animate-spin rounded-full border-2 border-white/10 border-t-accent" role="status" aria-label="Loading"
      style={{ width: size, height: size }} />
  )
}

export function CountUp({ to, decimals = 0, duration = 1.2, delay = 0, className, style }:
  { to: number; decimals?: number; duration?: number; delay?: number; className?: string; style?: React.CSSProperties }) {
  const mv = useMotionValue(0)
  const text = useTransform(mv, v => v.toFixed(decimals))
  useEffect(() => {
    const c = animate(mv, to, { duration, delay, ease: [0.16, 1, 0.3, 1] })
    return () => c.stop()
  }, [to, duration, delay, mv])
  return <motion.span className={className} style={style}>{text}</motion.span>
}

export function Modal({ open, onClose, title, children, wide }:
  { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    if (!open) return
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [open, onClose])
  return (
    <AnimatePresence>
      {open && (
        <motion.div className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4 backdrop-blur-[6px]"
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose}>
          <motion.div
            className={clsx('popover max-h-[90vh] w-full overflow-auto rounded-2xl p-6', wide ? 'max-w-3xl' : 'max-w-lg')}
            role="dialog" aria-modal="true"
            initial={{ scale: 0.97, y: 8, opacity: 0 }} animate={{ scale: 1, y: 0, opacity: 1 }} exit={{ scale: 0.98, y: 4, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 400, damping: 30 }}
            onClick={e => e.stopPropagation()}>
            <div className="mb-5 flex items-center justify-between">
              <h2 className="font-display text-lg font-semibold">{title}</h2>
              <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close"><X size={18} /></Button>
            </div>
            {children}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[13px] font-medium text-ink-200">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-ink-400">{hint}</span>}
    </label>
  )
}

export const inputCls = 'h-10 w-full rounded-[10px] bg-black/25 px-3.5 text-sm text-white ring-1 ring-inset ring-white/[0.09] placeholder:text-ink-500 outline-none transition hover:ring-white/[0.14] focus:ring-2 focus:ring-accent/60'

export function ErrorNote({ children }: { children: ReactNode }) {
  return <div role="alert" className="rounded-xl bg-blunder/10 px-4 py-3 text-sm text-[#ff98a6] ring-1 ring-inset ring-blunder/25">{children}</div>
}

/** Placeholder block while content loads (calmer than a spinner, and shows the layout to come). */
export function Skeleton({ className }: { className?: string }) {
  return <div className={clsx('skeleton', className)} aria-hidden />
}

/** Consistent page title block: optional eyebrow, title, description and actions on the right. */
export function PageHeader({ icon, eyebrow, title, description, actions }:
  { icon?: ReactNode; eyebrow?: ReactNode; title: ReactNode; description?: ReactNode; actions?: ReactNode }) {
  return (
    <motion.header initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
      className="flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        {eyebrow && <div className="mb-2 text-xs font-medium tracking-wide text-ink-400 uppercase">{eyebrow}</div>}
        <h1 className="flex items-center gap-3 font-display text-[28px] leading-tight font-semibold sm:text-[32px]">
          {icon && <span className="flex size-9 shrink-0 items-center justify-center rounded-[10px] bg-white/[0.05] ring-1 ring-inset ring-white/[0.08] [&>svg]:size-[18px]">{icon}</span>}
          {title}
        </h1>
        {description && <p className="mt-2 max-w-2xl text-[15px] leading-relaxed text-ink-400">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </motion.header>
  )
}

/** A page with nothing to show yet: what it will show, and the one action that gets you there. */
export function EmptyState({ icon, title, children, action }:
  { icon: ReactNode; title: ReactNode; children?: ReactNode; action?: ReactNode }) {
  return (
    <Card className="flex flex-col items-center px-6 py-14 text-center">
      <span className="flex size-12 items-center justify-center rounded-2xl bg-white/[0.05] text-ink-300 ring-1 ring-inset ring-white/[0.08] [&>svg]:size-6">{icon}</span>
      <h2 className="mt-4 font-display text-lg font-semibold">{title}</h2>
      {children && <p className="mt-1.5 max-w-md text-sm leading-relaxed text-ink-400">{children}</p>}
      {action && <div className="mt-5">{action}</div>}
    </Card>
  )
}

/** Whole-page placeholder: title, tiles and a big panel. */
export function PageSkeleton({ tiles = 4 }: { tiles?: number }) {
  return (
    <div className="mx-auto max-w-6xl space-y-6 px-4 py-8 lg:px-8">
      <Skeleton className="h-9 w-64" />
      <Skeleton className="h-4 w-96 max-w-full" />
      {tiles > 0 && <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">{Array.from({ length: tiles }, (_, i) => <Skeleton key={i} className="h-24" />)}</div>}
      <Skeleton className="h-72" />
    </div>
  )
}

/** In-page placeholder for a list or grid of cards. */
export function CardsSkeleton({ count = 4, className = 'grid gap-3 sm:grid-cols-2', h = 'h-24' }: { count?: number; className?: string; h?: string }) {
  return <div className={className}>{Array.from({ length: count }, (_, i) => <Skeleton key={i} className={h} />)}</div>
}

/** Review page placeholder: board on the left, panel on the right. */
export function BoardSkeleton() {
  return (
    <div className="mx-auto flex h-full max-w-[1400px] flex-col gap-4 p-4 lg:flex-row lg:p-6">
      <Skeleton className="aspect-square w-full max-w-[min(100%,calc(100vh-120px))] rounded-[14px]" />
      <Skeleton className="h-[480px] flex-1 rounded-2xl lg:h-auto lg:max-w-[440px]" />
    </div>
  )
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded-md bg-white/[0.07] px-1.5 font-mono text-[11px] text-ink-300 ring-1 ring-inset ring-white/[0.08]">{children}</kbd>
}
