import { codePath } from './codePath';

export function HistoricalToolCard({
  name,
  input,
  label,
  output,
  result = false,
  onOpenPath,
}: {
  name?: string;
  input: string;
  label?: string;
  output?: string;
  result?: boolean;
  onOpenPath?: (path: string) => void;
}): JSX.Element {
  const body = result ? input : output;
  const summary = label || input.split('\n').find((line) => line.trim()) || 'Tool record';
  return (
    <details className="sv-tool sv-historical-tool">
      <summary>
        <span className="sv-historical-chevron">›</span>
        <span className="sv-tool-name">{result ? 'Tool result' : name || 'Tool'}</span>
        <span className="sv-tool-input" title={summary}>
          {summary}
        </span>
        <span className="sv-tool-count" title="Imported evidence only — not a running tool">
          Imported
        </span>
      </summary>
      {!result && (
        <div className="sv-historical-section">
          <div className="sv-historical-heading">Input</div>
          <pre className="sv-tool-pre">{input || '(empty input)'}</pre>
        </div>
      )}
      {body !== undefined && (
        <div className="sv-historical-section">
          <div className="sv-historical-heading">Output</div>
          <pre className="sv-tool-pre">
            {body
              ? body.split('\n').map((line, index) => {
                  const target = codePath(line);
                  return (
                    <span key={`${index}:${line}`}>
                      {index > 0 && '\n'}
                      {target && onOpenPath ? (
                        <button
                          type="button"
                          className="sv-historical-path"
                          onClick={() => onOpenPath(target.path)}
                        >
                          {line}
                        </button>
                      ) : (
                        line
                      )}
                    </span>
                  );
                })
              : '(no output)'}
          </pre>
        </div>
      )}
    </details>
  );
}
