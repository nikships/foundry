import { useMemo } from 'react';
import { generateQrMatrix, type ErrorCorrectionLevel } from './qr-matrix.js';

export interface QrCodeProps {
  value: string;
  size?: number;
  ecLevel?: ErrorCorrectionLevel;
  bgColor?: string;
  fgColor?: string;
  margin?: number;
  className?: string;
  title?: string;
}

export default function QrCode({
  value,
  size = 200,
  ecLevel = 'M',
  bgColor = '#FFFFFF',
  fgColor = '#000000',
  margin = 2,
  className,
  title,
}: QrCodeProps): React.JSX.Element {
  const { pathData, totalSize } = useMemo(() => {
    if (!value) return { pathData: '', totalSize: 0 };
    try {
      const { matrix, size: matrixSize } = generateQrMatrix(value, ecLevel);
      const totalSize = matrixSize + margin * 2;

      let d = '';
      for (let r = 0; r < matrixSize; r++) {
        for (let c = 0; c < matrixSize; c++) {
          if (matrix[r]![c]) d += `M${c + margin},${r + margin}h1v1h-1z `;
        }
      }
      return { pathData: d.trim(), totalSize };
    } catch {
      return { pathData: '', totalSize: 0 };
    }
  }, [value, ecLevel, margin]);

  if (!pathData || totalSize === 0) {
    return <div style={{ width: size, height: size }} className={className} />;
  }

  return (
    <svg
      role="img"
      aria-label={title ?? 'QR code'}
      viewBox={`0 0 ${totalSize} ${totalSize}`}
      width={size}
      height={size}
      className={className}
      style={{ display: 'block', shapeRendering: 'crispEdges' }}
    >
      {title && <title>{title}</title>}
      {bgColor !== 'transparent' && (
        <rect width={totalSize} height={totalSize} fill={bgColor} rx={1} />
      )}
      <path d={pathData} fill={fgColor} />
    </svg>
  );
}
