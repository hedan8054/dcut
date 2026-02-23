import { useState, useCallback } from 'react'
import { X } from 'lucide-react'

/**
 * 可点击放大的缩略图组件
 * 点击弹出全屏预览，点击遮罩或 X 关闭
 */
export function ClickableImage({
  src,
  alt = '',
  className = '',
  fallback,
}: {
  src: string
  alt?: string
  className?: string
  fallback?: React.ReactNode
}) {
  const [open, setOpen] = useState(false)
  const [errored, setErrored] = useState(false)

  const handleOpen = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    setOpen(true)
  }, [])

  if (errored && fallback) return <>{fallback}</>

  return (
    <>
      <img
        src={src}
        alt={alt}
        className={`${className} cursor-zoom-in`}
        onClick={handleOpen}
        onError={() => setErrored(true)}
      />
      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80"
          onClick={() => setOpen(false)}
        >
          <button
            className="absolute top-4 right-4 text-white/80 hover:text-white"
            onClick={() => setOpen(false)}
          >
            <X className="w-6 h-6" />
          </button>
          <img
            src={src}
            alt={alt}
            className="max-w-[90vw] max-h-[90vh] object-contain rounded"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}
    </>
  )
}
