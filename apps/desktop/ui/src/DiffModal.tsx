import { useEffect, useState } from 'react';
import { DiffLines } from './DiffLines';
import { imageObjectUrl } from './imageBlob';

/** A blob URL for base64 image bytes, revoked when they change or unmount.
 *  Never a data: URL — see imageBlob.ts. */
function useImageUrl(base64: string | undefined, mime: string): string {
  const [url, setUrl] = useState('');
  useEffect(() => {
    if (!base64) {
      setUrl('');
      return;
    }
    const u = imageObjectUrl(base64, mime);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [base64, mime]);
  return url;
}

/** Unified-diff viewer modal (JetBrains-flavored): mono, line-tinted
 *  add/del/hunk rows. Fed by workspace.diff raw output — an image file
 *  (`image` set) renders a before/after comparison instead of text lines;
 *  one side is absent for a new or deleted file. */
export function DiffModal({
  title,
  diff,
  truncated,
  image,
  onClose,
}: {
  title: string;
  diff: string;
  truncated: boolean;
  image?: { before?: string; after?: string; mime: string };
  onClose: () => void;
}): JSX.Element {
  const beforeUrl = useImageUrl(image?.before, image?.mime ?? 'image/png');
  const afterUrl = useImageUrl(image?.after, image?.mime ?? 'image/png');
  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal diff-modal" onClick={(e) => e.stopPropagation()}>
        <div className="diff-head">
          <h3>{title}</h3>
          {truncated && <span className="fv-warn">truncated</span>}
          <button type="button" className="diff-close" onClick={onClose}>
            ✕
          </button>
        </div>
        {image ? (
          <div className="diff-image-body">
            <div className="diff-image-col">
              <span className="diff-image-label">Before</span>
              {image.before ? (
                <img className="diff-image" src={beforeUrl} alt="before" />
              ) : (
                <div className="diff-image-empty muted small">new file</div>
              )}
            </div>
            <div className="diff-image-col">
              <span className="diff-image-label">After</span>
              {image.after ? (
                <img className="diff-image" src={afterUrl} alt="after" />
              ) : (
                <div className="diff-image-empty muted small">deleted</div>
              )}
            </div>
          </div>
        ) : (
          <div className="diff-body mono">
            <DiffLines diff={diff} />
          </div>
        )}
      </div>
    </div>
  );
}
