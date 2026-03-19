/** Reusable skeleton loading blocks. */

export function SkeletonRow({ cols = 5 }: { cols?: number }) {
  return (
    <div className="flex gap-4 py-3" style={{ borderBottom: '1px solid var(--border-primary)' }}>
      {Array.from({ length: cols }).map((_, i) => (
        <div
          key={i}
          className="animate-pulse rounded"
          style={{
            background: 'var(--bg-tertiary)',
            height: '16px',
            width: i === 0 ? '140px' : '60px',
          }}
        />
      ))}
    </div>
  );
}

export function SkeletonTable({ rows = 4, cols }: { rows?: number; cols?: number }) {
  return (
    <div>
      {Array.from({ length: rows }).map((_, i) => (
        <SkeletonRow key={i} cols={cols} />
      ))}
    </div>
  );
}

export function SkeletonLine({ width = '200px' }: { width?: string }) {
  return (
    <div
      className="animate-pulse rounded"
      style={{ background: 'var(--bg-tertiary)', height: '14px', width }}
    />
  );
}

export function SkeletonTimeline({ rows = 5 }: { rows?: number }) {
  return (
    <div className="space-y-3">
      {Array.from({ length: rows }).map((_, i) => (
        <SkeletonLine key={i} width={i % 2 === 0 ? '80%' : '60%'} />
      ))}
    </div>
  );
}
