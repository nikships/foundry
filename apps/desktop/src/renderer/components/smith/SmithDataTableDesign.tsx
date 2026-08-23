/**
 * Read-only data table design body for Smith's chat:
 * displays bounded typed entity/run/project catalogs with column alignment,
 * status chips, empty states, and safe navigation affordances.
 */

import type { DataTableDef, TableColumnDef, TableRowDef } from '@shared/types.js';
import { dataTableSummary, formatCellValue } from '../../view-models/smith-artifact-view.js';
import { cx } from '../ui/cx.js';
import styles from './SmithDataTableDesign.module.css';

function TableCell({
  column,
  row,
}: {
  column: TableColumnDef;
  row: TableRowDef;
}): React.JSX.Element {
  const rawValue = row.cells[column.key];
  const { text, status } = formatCellValue(rawValue);

  const alignClass =
    column.align === 'center'
      ? styles.alignCenter
      : column.align === 'right'
        ? styles.alignRight
        : styles.alignLeft;

  if (status) {
    return (
      <td className={alignClass}>
        <span className={cx(styles.statusChip, styles[`status_${status.variant}`])}>
          {status.label}
        </span>
      </td>
    );
  }

  if (column.type === 'code') {
    return (
      <td className={cx(alignClass, styles.codeCell)}>
        <code>{text}</code>
      </td>
    );
  }

  return <td className={alignClass}>{text}</td>;
}

export function DataTableDesign({
  table,
  compact,
}: {
  table: DataTableDef;
  compact?: boolean;
}): React.JSX.Element {
  const summary = dataTableSummary(table);
  const isEmpty = table.rows.length === 0;

  return (
    <div
      className={cx(styles.dataTable, compact && styles.compact)}
      data-testid="smith-data-table-design"
    >
      <div className={styles.summaryBar}>
        <span className={styles.summaryText}>{summary}</span>
        {table.catalogKind && <span className={styles.catalogKindTag}>{table.catalogKind}</span>}
      </div>

      <div className={styles.tableContainer}>
        {isEmpty ? (
          <div className={styles.emptyState} data-testid="data-table-empty">
            <span className={styles.emptyMessage}>
              {table.emptyState?.message ?? 'No catalog items'}
            </span>
            {table.emptyState?.subtext && (
              <span className={styles.emptySubtext}>{table.emptyState.subtext}</span>
            )}
          </div>
        ) : (
          <table className={styles.table}>
            <thead>
              <tr>
                {table.columns.map((column) => (
                  <th
                    key={column.key}
                    scope="col"
                    style={column.width ? { width: column.width } : undefined}
                    className={
                      column.align === 'center'
                        ? styles.alignCenter
                        : column.align === 'right'
                          ? styles.alignRight
                          : styles.alignLeft
                    }
                  >
                    {column.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {table.rows.map((row) => (
                <tr key={row.id} data-testid={`table-row-${row.id}`}>
                  {table.columns.map((column) => (
                    <TableCell key={`${row.id}-${column.key}`} column={column} row={row} />
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
