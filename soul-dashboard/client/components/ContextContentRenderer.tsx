/**
 * ContextContentRenderer - context item의 content를 타입에 따라 렌더링
 *
 * string → pre 블록
 * number/boolean → 인라인 텍스트
 * Array<object> → 테이블
 * Array<scalar> → 목록
 * plain object → key-value 2컬럼 테이블
 * null/undefined → 대시
 */

interface ContextContentRendererProps {
  content: unknown;
}

export function ContextContentRenderer({ content }: ContextContentRendererProps) {
  if (content === null || content === undefined) {
    return <span className="text-gray-400">—</span>;
  }

  if (typeof content === "string") {
    return (
      <pre className="text-xs whitespace-pre-wrap break-words max-h-[200px] overflow-y-auto bg-gray-50 px-2 py-1 rounded flex-1">
        {content}
      </pre>
    );
  }

  if (typeof content === "number" || typeof content === "boolean") {
    return <span className="text-xs text-gray-700">{String(content)}</span>;
  }

  if (Array.isArray(content)) {
    if (content.length === 0) {
      return <span className="text-gray-400">—</span>;
    }

    const firstItem = content[0];
    const isObjectArray = typeof firstItem === "object" && firstItem !== null;

    if (isObjectArray) {
      // Array<object> → 테이블
      const allKeys = Array.from(
        new Set(content.flatMap(row => (typeof row === "object" && row !== null ? Object.keys(row as object) : [])))
      );
      return (
        <div className="overflow-x-auto flex-1">
          <table className="text-xs border-collapse w-full">
            <thead>
              <tr>
                {allKeys.map(key => (
                  <th key={key} className="border border-gray-200 px-2 py-1 bg-gray-100 text-left font-medium text-gray-600">
                    {key}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {content.map((row, i) => (
                <tr key={i}>
                  {allKeys.map(key => (
                    <td key={key} className="border border-gray-200 px-2 py-1 text-gray-700">
                      {(row as Record<string, unknown>)[key] !== undefined
                        ? String((row as Record<string, unknown>)[key])
                        : "—"}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    } else {
      // Array<scalar> → 목록
      return (
        <ul className="text-xs list-disc list-inside flex-1 space-y-0.5">
          {content.map((item, i) => (
            <li key={i} className="text-gray-700">{String(item)}</li>
          ))}
        </ul>
      );
    }
  }

  if (typeof content === "object") {
    // plain object → key-value 2컬럼 테이블
    const entries = Object.entries(content as Record<string, unknown>);
    return (
      <div className="overflow-x-auto flex-1">
        <table className="text-xs border-collapse w-full">
          <tbody>
            {entries.map(([key, val]) => (
              <tr key={key}>
                <td className="border border-gray-200 px-2 py-1 bg-gray-50 font-medium text-gray-600 whitespace-nowrap">{key}</td>
                <td className="border border-gray-200 px-2 py-1 text-gray-700">{String(val)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  // fallback
  return (
    <pre className="text-xs whitespace-pre-wrap break-words max-h-[200px] overflow-y-auto bg-gray-50 px-2 py-1 rounded flex-1">
      {JSON.stringify(content, null, 2)}
    </pre>
  );
}
