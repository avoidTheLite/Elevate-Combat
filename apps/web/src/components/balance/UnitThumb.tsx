import { useEffect, useState } from 'react';
import { unitThumbnail } from '../../balance/thumbnails.ts';

/** Rendered unit model (shared offscreen renderer), or a text badge without WebGL. */
export function UnitThumb({
  typeId,
  short,
  color,
}: {
  typeId: string;
  short: string;
  color: number;
}): React.ReactElement {
  const [url, setUrl] = useState<string | null>(null);
  const [tried, setTried] = useState(false);
  useEffect(() => {
    // Render after paint so the grid appears immediately.
    const id = setTimeout(() => {
      setUrl(unitThumbnail(typeId, color));
      setTried(true);
    }, 0);
    return () => clearTimeout(id);
  }, [typeId, color]);

  return (
    <div className="w-[72px] h-[72px] shrink-0 border border-[hsl(var(--border-bright))] bg-[hsl(var(--background))] flex items-center justify-center">
      {url ? (
        <img src={url} alt={`${typeId} model`} className="w-full h-full object-contain" />
      ) : (
        <span
          className="text-[13px] font-bold tracking-widest text-[hsl(var(--primary))] text-glow"
          data-testid="thumb-fallback"
          title={tried ? '3D preview unavailable (no WebGL)' : undefined}
        >
          {short}
        </span>
      )}
    </div>
  );
}
