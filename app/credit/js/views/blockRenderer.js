import { escapeHTML } from '../utils.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

function hasNativeDOM() {
  return typeof document !== 'undefined' && typeof document.createElement === 'function';
}

function createVirtualElement(tagName) {
  const node = {
    tagName: String(tagName || 'div').toLowerCase(),
    className: '',
    textContent: '',
    attributes: new Map(),
    style: {},
    dataset: {},
    children: [],
    listeners: new Map(),
    setAttribute(name, value) {
      this.attributes.set(String(name), String(value));
    },
    appendChild(child) {
      if (child) this.children.push(child);
      return child;
    },
    replaceChildren(...newChildren) {
      this.children = newChildren.filter(Boolean);
    },
    addEventListener(type, fn) {
      this.listeners.set(type, fn);
    },
    toHTML() {
      const attrs = [];
      if (this.className) attrs.push(`class="${escapeHTML(this.className)}"`);
      for (const [k, v] of this.attributes.entries()) {
        attrs.push(`${escapeHTML(k)}="${escapeHTML(v)}"`);
      }
      for (const [dk, dv] of Object.entries(this.dataset)) {
        const kebab = dk.replace(/[A-Z]/g, m => `-${m.toLowerCase()}`);
        attrs.push(`data-${escapeHTML(kebab)}="${escapeHTML(String(dv))}"`);
      }
      const styleEntries = Object.entries(this.style).filter(([, v]) => v !== undefined && v !== '');
      if (styleEntries.length) {
        const styleStr = styleEntries
          .map(([k, v]) => `${k.replace(/[A-Z]/g, m => `-${m.toLowerCase()}`)}: ${v}`)
          .join('; ');
        attrs.push(`style="${escapeHTML(styleStr)}"`);
      }
      const openTag = attrs.length ? `<${this.tagName} ${attrs.join(' ')}>` : `<${this.tagName}>`;
      if (['hr', 'br', 'input'].includes(this.tagName)) return openTag;
      const inner = this.children.length
        ? this.children.map(c => (typeof c.toHTML === 'function' ? c.toHTML() : escapeHTML(String(c?.textContent || '')))).join('')
        : escapeHTML(String(this.textContent || ''));
      return `${openTag}${inner}</${this.tagName}>`;
    }
  };
  return node;
}

export function createEl(tag, options = {}, children = []) {
  const el = hasNativeDOM() ? document.createElement(tag) : createVirtualElement(tag);
  if (options.className) el.className = options.className;
  if (options.text !== undefined && options.text !== null) {
    el.textContent = String(options.text);
  }
  if (options.attrs) {
    for (const [k, v] of Object.entries(options.attrs)) {
      if (v !== undefined && v !== null) el.setAttribute(k, String(v));
    }
  }
  if (options.dataset) {
    for (const [k, v] of Object.entries(options.dataset)) {
      if (v !== undefined && v !== null) {
        if (el.dataset) el.dataset[k] = String(v);
        else el.setAttribute(`data-${k}`, String(v));
      }
    }
  }
  if (options.style && el.style) {
    for (const [k, v] of Object.entries(options.style)) {
      if (v !== undefined && v !== null) el.style[k] = v;
    }
  }
  if (typeof options.onClick === 'function' && typeof el.addEventListener === 'function') {
    el.addEventListener('click', options.onClick);
  }
  for (const child of children) {
    if (child) el.appendChild(child);
  }
  return el;
}

function createSvgEl(tag, attrs = {}, children = []) {
  const el = hasNativeDOM() && typeof document.createElementNS === 'function'
    ? document.createElementNS(SVG_NS, tag)
    : createVirtualElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v !== undefined && v !== null) el.setAttribute(k, String(v));
  }
  for (const child of children) {
    if (child) el.appendChild(child);
  }
  return el;
}

export function formatINRCurrency(value) {
  if (value === null || value === undefined || value === '—') return '—';
  if (typeof value === 'string' && value.trim().startsWith('₹')) return value.trim();
  const num = Number(value);
  if (!Number.isFinite(num)) return String(value);
  const sign = num < 0 ? '-' : '';
  return `${sign}₹${Math.abs(num).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
}

export function createBadgeEl(term) {
  const clean = String(term ?? '').trim();
  const upper = clean.toUpperCase();
  let cls = 'badge-gray';
  if (['BREACH', 'BREACHED', 'CRITICAL', 'REJECT', 'REJECTED', 'FAIL', 'FAILED', 'ERROR', 'NO LIMIT SET'].includes(upper)) {
    cls = 'badge-red';
  } else if (['WARNING', 'OVERDUE_RISK', 'STALE_REVIEW', 'MANUAL_REVIEW', 'CONDITIONAL_APPROVAL', 'WARN', 'HIGH', 'MEDIUM', 'STANDBY', 'PENDING', 'PENDING_APPROVAL'].includes(upper)) {
    cls = 'badge-amber';
  } else if (['OVERDUE_AMOUNT', 'OVERDUE', 'LATE', 'DEMO'].includes(upper)) {
    cls = 'badge-orange';
  } else if (['OK', 'HEALTHY', 'NORMAL', 'COMPLETED', 'PASS', 'APPROVE', 'APPROVED', 'LOW', 'ACTIVE', 'CONNECTED', 'LIVE'].includes(upper)) {
    cls = 'badge-green';
  }
  return createEl('span', { className: `ai-badge ${cls}`, text: clean || '—' });
}

export function createValueKindBadge(valueKind) {
  if (!valueKind) return null;
  const kind = String(valueKind).toUpperCase();
  const cls = kind === 'SIMULATED'
    ? 're-kind-simulated'
    : kind === 'ACTUAL'
      ? 're-kind-actual'
      : 're-kind-calculated';
  return createEl('span', { className: `re-kind-badge ${cls}`, text: kind });
}

function renderTextBlock(block) {
  return createEl('p', {
    className: 'ai-paragraph re-text-block',
    text: block.text || ''
  });
}

function renderNoticeBlock(block) {
  const sev = String(block.severity || 'info').toLowerCase();
  const isSim = /SIMULATION/i.test(block.title || '') || /SIMULATION/i.test(block.message || '');
  return createEl('div', {
    className: `re-notice-card re-notice-${sev}${isSim ? ' re-notice-simulation' : ''}`
  }, [
    createEl('div', { className: 're-notice-header' }, [
      createEl('strong', { className: 're-notice-title', text: block.title || 'Notice' }),
      isSim ? createValueKindBadge('SIMULATED') : null
    ]),
    createEl('p', { className: 're-notice-message', text: block.message || '' })
  ]);
}

function renderMetricsBlock(block) {
  const items = Array.isArray(block.items) ? block.items.slice(0, 4) : [];
  const cards = items.map(item => {
    const sev = String(item.severity || 'neutral').toLowerCase();
    const cardCls = sev === 'critical'
      ? 'ai-kpi-card kpi-breach'
      : sev === 'warning'
        ? 'ai-kpi-card kpi-warning'
        : 'ai-kpi-card';
    const valCls = sev === 'critical'
      ? 'ai-kpi-val text-red'
      : sev === 'warning'
        ? 'ai-kpi-val text-amber'
        : 'ai-kpi-val text-navy';

    return createEl('div', { className: cardCls }, [
      createEl('div', { className: 're-kpi-top' }, [
        createEl('span', { className: 'ai-kpi-label', text: item.label || '' }),
        createValueKindBadge(item.valueKind)
      ]),
      createEl('div', { className: valCls, text: String(item.value ?? '—') }),
      item.subtitle ? createEl('div', { className: 'ai-kpi-sub', text: item.subtitle }) : null
    ]);
  });

  return createEl('div', { className: 'ai-kpi-summary-grid re-metrics-block' }, cards);
}

function formatCellNode(col, row, columns = []) {
  const rawVal = row?.[col.key];
  const fmt = col.format || 'text';

  if (col.key === 'ID' || col.key === 'id' || col.key === 'customerId') {
    const idStr = String(rawVal ?? '').trim();
    return idStr
      ? createEl('code', { className: 'ai-id-chip', text: idStr.toUpperCase() })
      : createEl('span', { className: 'muted', text: '—' });
  }

  if (col.key === 'customer') {
    const str = String(rawVal ?? '');
    const hasSeparateIdCol = Array.isArray(columns) && columns.some(c => c.key === 'ID' || c.key === 'id' || c.key === 'customerId');
    const match = str.match(/\b((?:MS-)?C\d{3})\b/i);
    if (match) {
      const id = match[1].toUpperCase();
      const name = str.replace(match[0], '').replace(/[()]/g, '').trim();
      if (hasSeparateIdCol && name) {
        return createEl('strong', { className: 'ai-customer-name', text: name });
      }
      return createEl('div', { className: 'ai-customer-cell' }, [
        name ? createEl('strong', { className: 'ai-customer-name', text: name }) : null,
        createEl('code', { className: 'ai-id-chip', text: id })
      ]);
    }
    return createEl('strong', { className: 'ai-customer-name', text: str || '—' });
  }

  if (fmt === 'currency') {
    return createEl('span', { className: 'tabular-num', text: formatINRCurrency(rawVal) });
  }

  if (fmt === 'percent') {
    if (rawVal === null || rawVal === undefined || row?.isNoLimit) {
      return createEl('span', { className: 'ai-badge badge-amber', text: row?.utilisationDisplay || 'N/A (no limit)' });
    }
    const pct = Number(rawVal);
    if (!Number.isFinite(pct)) {
      return createEl('span', { text: String(rawVal) });
    }
    const colorClass = pct >= 100 ? 'breach' : pct >= 80 ? 'warning' : 'healthy';
    const cappedWidth = Math.min(100, Math.max(0, pct));
    return createEl('div', { className: 'ai-util-cell' }, [
      createEl('div', { className: 'ai-util-bar-track' }, [
        createEl('div', {
          className: `ai-util-bar-fill ${colorClass}`,
          style: { width: `${cappedWidth.toFixed(1)}%` }
        })
      ]),
      createEl('span', { className: `ai-util-label ${colorClass}`, text: `${pct.toFixed(1)}%` })
    ]);
  }

  if (fmt === 'badge') {
    const str = String(rawVal ?? '').trim();
    if (!str || str === '—') return createEl('span', { className: 'muted', text: '—' });
    const parts = str.split(',').map(s => s.trim()).filter(Boolean);
    if (parts.length > 1) {
      return createEl('div', { className: 'badge-group', style: { display: 'flex', flexWrap: 'wrap', gap: '4px' } },
        parts.map(p => createBadgeEl(p))
      );
    }
    return createBadgeEl(parts[0] || str);
  }

  if (fmt === 'number') {
    const num = Number(rawVal);
    return createEl('span', {
      className: 'tabular-num',
      text: Number.isFinite(num) ? num.toLocaleString('en-IN') : String(rawVal ?? '—')
    });
  }

  return createEl('span', { text: rawVal !== undefined && rawVal !== null ? String(rawVal) : '—' });
}

function renderTableBlock(block) {
  const columns = Array.isArray(block.columns) ? block.columns : [];
  const allRows = Array.isArray(block.rows) ? [...block.rows] : [];
  const pageSize = Number.isInteger(block.pageSize) && block.pageSize > 0 ? block.pageSize : 10;

  let currentSortKey = block.sortBy || null;
  let currentSortDir = block.sortDir === 'asc' ? 'asc' : 'desc';
  let currentPage = 0;
  let showAll = Boolean(block.showAllByDefault);

  const wrapper = createEl('div', { className: 're-table-section' });
  if (block.title) {
    wrapper.appendChild(createEl('div', { className: 're-block-header' }, [
      createEl('h4', { className: 're-block-title', text: block.title }),
      createEl('span', { className: 're-row-count-chip', text: `${allRows.length} ${allRows.length === 1 ? 'record' : 'records'}` })
    ]));
  }

  const tableWrap = createEl('div', { className: 'ai-table-wrap' });
  const tableEl = createEl('table', { className: 'ai-table' });
  const thead = createEl('thead');
  const tbody = createEl('tbody');
  const paginationBar = createEl('div', { className: 're-table-pagination' });

  function getSortedRows() {
    if (!currentSortKey) return allRows;
    const dir = currentSortDir === 'asc' ? 1 : -1;
    return [...allRows].sort((a, b) => {
      const va = a?.[currentSortKey];
      const vb = b?.[currentSortKey];
      const na = typeof va === 'number' ? va : Number.NaN;
      const nb = typeof vb === 'number' ? vb : Number.NaN;
      if (Number.isFinite(na) && Number.isFinite(nb)) {
        return (na - nb) * dir;
      }
      if (va === null || va === undefined) return 1;
      if (vb === null || vb === undefined) return -1;
      return String(va).localeCompare(String(vb)) * dir;
    });
  }

  function renderHeader() {
    const tr = createEl('tr');
    for (const col of columns) {
      const alignCls = col.align === 'right' ? 'text-right' : 'text-left';
      const isSorted = currentSortKey === col.key;
      const arrow = isSorted ? (currentSortDir === 'asc' ? ' ↑' : ' ↓') : '';
      const th = createEl('th', {
        className: `${alignCls} re-sortable-th`,
        text: `${col.label || col.key}${arrow}`,
        onClick: () => {
          if (currentSortKey === col.key) {
            currentSortDir = currentSortDir === 'asc' ? 'desc' : 'asc';
          } else {
            currentSortKey = col.key;
            currentSortDir = col.format === 'currency' || col.format === 'percent' || col.format === 'number' ? 'desc' : 'asc';
          }
          currentPage = 0;
          renderHeader();
          renderBody();
        }
      });
      tr.appendChild(th);
    }
    thead.replaceChildren(tr);
  }

  function renderBody() {
    const sorted = getSortedRows();
    const start = showAll ? 0 : currentPage * pageSize;
    const pageRows = showAll ? sorted : sorted.slice(start, start + pageSize);

    const rowNodes = pageRows.map(row => {
      const tr = createEl('tr', { className: 'ai-table-row' });
      for (const col of columns) {
        const alignCls = col.align === 'right' ? 'text-right tabular-num' : 'text-left';
        const td = createEl('td', { className: alignCls }, [formatCellNode(col, row, columns)]);
        tr.appendChild(td);
      }
      return tr;
    });

    tbody.replaceChildren(...rowNodes);

    if (sorted.length > pageSize) {
      const totalPages = Math.ceil(sorted.length / pageSize);
      const infoText = showAll
        ? `Showing all ${sorted.length} of ${sorted.length}`
        : `Showing ${start + 1}–${Math.min(sorted.length, start + pageSize)} of ${sorted.length}`;
      const info = createEl('span', { className: 're-page-info', text: infoText });

      const actions = [];
      actions.push(createEl('button', {
        className: 'button secondary re-page-btn re-show-all-btn',
        text: showAll ? `Show top ${pageSize}` : `Show all ${sorted.length}`,
        attrs: { type: 'button', 'data-show-all-toggle': 'true' },
        onClick: () => {
          showAll = !showAll;
          currentPage = 0;
          renderBody();
        }
      }));

      if (!showAll) {
        actions.push(createEl('button', {
          className: 'button secondary re-page-btn',
          text: 'Previous',
          attrs: { type: 'button', ...(currentPage === 0 ? { disabled: 'disabled' } : {}) },
          onClick: () => {
            if (currentPage > 0) {
              currentPage -= 1;
              renderBody();
            }
          }
        }));
        actions.push(createEl('button', {
          className: 'button secondary re-page-btn',
          text: 'Next',
          attrs: { type: 'button', ...(currentPage >= totalPages - 1 ? { disabled: 'disabled' } : {}) },
          onClick: () => {
            if (currentPage < totalPages - 1) {
              currentPage += 1;
              renderBody();
            }
          }
        }));
      }

      paginationBar.replaceChildren(info, createEl('div', { className: 're-page-actions' }, actions));
    } else {
      paginationBar.replaceChildren();
    }
  }

  renderHeader();
  renderBody();

  tableEl.appendChild(thead);
  tableEl.appendChild(tbody);
  tableWrap.appendChild(tableEl);
  wrapper.appendChild(tableWrap);
  if (allRows.length > pageSize) {
    wrapper.appendChild(paginationBar);
  }

  return wrapper;
}

function renderSvgDonutChart(block) {
  const data = block.series?.[0]?.data || [];
  const total = data.reduce((sum, d) => sum + Math.max(0, Number(d.value || 0)), 0);
  const palette = ['#1d4ed8', '#0284c7', '#d97706', '#dc2626', '#059669', '#7c3aed'];
  const statusColor = (status, idx) => {
    const s = String(status || '').toUpperCase();
    if (s === 'BREACH' || s === 'CRITICAL') return '#dc2626';
    if (s === 'WARNING' || s === 'MEDIUM') return '#d97706';
    if (s === 'HEALTHY' || s === 'LOW') return '#16a34a';
    return palette[idx % palette.length];
  };

  const size = 180;
  const cx = size / 2;
  const cy = size / 2;
  const r = 62;
  const circumference = 2 * Math.PI * r;

  const svg = createSvgEl('svg', {
    viewBox: `0 0 ${size} ${size}`,
    width: String(size),
    height: String(size),
    class: 're-donut-svg',
    role: 'img',
    'aria-label': block.title || 'Donut chart'
  });

  svg.appendChild(createSvgEl('circle', {
    cx,
    cy,
    r,
    fill: 'none',
    stroke: '#f1f5f9',
    'stroke-width': '24'
  }));

  let offset = 0;
  data.forEach((d, idx) => {
    const val = Math.max(0, Number(d.value || 0));
    const frac = total > 0 ? val / total : 0;
    const dash = frac * circumference;
    const circle = createSvgEl('circle', {
      cx,
      cy,
      r,
      fill: 'none',
      stroke: statusColor(d.status, idx),
      'stroke-width': '24',
      'stroke-dasharray': `${dash.toFixed(2)} ${(circumference - dash).toFixed(2)}`,
      'stroke-dashoffset': String((-offset).toFixed(2)),
      transform: `rotate(-90 ${cx} ${cy})`
    });
    offset += dash;
    svg.appendChild(circle);
  });

  const centerText = createSvgEl('text', {
    x: cx,
    y: cy + 4,
    'text-anchor': 'middle',
    fill: '#0f172a',
    'font-size': '13',
    'font-weight': '700'
  });
  centerText.textContent = block.unit === 'INR' ? formatINRCurrency(total) : `${total}`;
  svg.appendChild(centerText);

  const legend = createEl('div', { className: 're-donut-legend' },
    data.map((d, idx) => {
      const val = Number(d.value || 0);
      const pct = total > 0 ? ((val / total) * 100).toFixed(1) : '0.0';
      const formattedVal = block.unit === 'INR' ? formatINRCurrency(val) : String(val);
      return createEl('div', { className: 're-donut-legend-item' }, [
        createEl('span', {
          className: 're-legend-swatch',
          style: { backgroundColor: statusColor(d.status, idx) }
        }),
        createEl('span', { className: 're-legend-label', text: d.label || '' }),
        createEl('strong', { className: 're-legend-val tabular-num', text: `${formattedVal} (${pct}%)` })
      ]);
    })
  );

  return createEl('div', { className: 're-donut-layout' }, [svg, legend]);
}

function renderHBarChart(block) {
  const data = block.series?.[0]?.data || [];
  const isPercent = block.unit === 'PERCENT';
  const maxVal = Math.max(
    ...data.map(d => Number(d.value || 0)),
    ...(block.thresholds || []).map(t => Number(t.value || 0)),
    isPercent ? 100 : 1
  );
  const scaleMax = isPercent ? Math.max(120, Math.ceil((maxVal + 10) / 20) * 20) : maxVal * 1.08;

  const markersWrap = createEl('div', { className: 'ai-chart-markers' });
  for (const t of (block.thresholds || [])) {
    const pos = Math.min(100, Math.max(0, (Number(t.value) / scaleMax) * 100));
    const cls = t.severity === 'critical' ? 'marker-100' : 'marker-80';
    markersWrap.appendChild(createEl('div', {
      className: `ai-marker ${cls}`,
      style: { left: `${pos.toFixed(1)}%` }
    }, [
      createEl('span', { className: 'marker-tag', text: t.label })
    ]));
  }

  const rowsWrap = createEl('div', { className: 'ai-chart-rows' },
    data.map(d => {
      const val = Number(d.value || 0);
      const widthPct = scaleMax > 0 ? Math.min(100, Math.max(2, (val / scaleMax) * 100)) : 2;
      const status = String(d.status || '').toUpperCase();
      const colorClass = status === 'BREACH' || (isPercent && val >= 100)
        ? 'breach'
        : status === 'WARNING' || (isPercent && val >= 80)
          ? 'warning'
          : 'healthy';
      const valDisplay = isPercent ? `${val.toFixed(1)}%` : formatINRCurrency(val);

      return createEl('div', { className: `ai-chart-row${d.highlight ? ' re-row-highlight' : ''}` }, [
        createEl('div', { className: 'ai-chart-label', attrs: { title: d.label || '' } }, [
          createEl('span', { className: 'ai-chart-name', text: d.label || '' })
        ]),
        createEl('div', { className: 'ai-chart-track-container' }, [
          createEl('div', {
            className: `ai-chart-fill ${colorClass}`,
            style: { width: `${widthPct.toFixed(1)}%` }
          })
        ]),
        createEl('div', { className: `ai-chart-pct ${colorClass} tabular-num`, text: valDisplay })
      ]);
    })
  );

  return createEl('div', { className: 'ai-chart-wrap' }, [
    (block.thresholds && block.thresholds.length > 0) ? markersWrap : null,
    rowsWrap
  ]);
}

function renderGroupedOrVerticalBarChart(block) {
  const seriesList = Array.isArray(block.series) ? block.series : [];
  if (seriesList.length === 0) return null;
  const categories = (seriesList[0].data || []).map(d => d.label || d.shortLabel || '');
  const allValues = seriesList.flatMap(s => (s.data || []).map(d => Number(d.value || 0)));
  const maxVal = Math.max(...allValues, 1);

  const seriesColors = ['#2563eb', '#f59e0b', '#dc2626', '#10b981'];

  const legend = seriesList.length > 1
    ? createEl('div', { className: 're-chart-series-legend' },
        seriesList.map((s, idx) => createEl('span', { className: 're-series-chip' }, [
          createEl('span', { className: 're-legend-swatch', style: { backgroundColor: seriesColors[idx % seriesColors.length] } }),
          createEl('span', { text: s.name || `Series ${idx + 1}` })
        ]))
      )
    : null;

  const groupsEl = createEl('div', { className: 're-grouped-bars' },
    categories.map((catLabel, catIdx) => {
      const bars = seriesList.map((s, sIdx) => {
        const point = s.data?.[catIdx] || { value: 0 };
        const val = Number(point.value || 0);
        const pct = maxVal > 0 ? Math.min(100, Math.max(2, (val / maxVal) * 100)) : 2;
        const valText = block.unit === 'INR' ? formatINRCurrency(val) : `${val}`;
        const color = seriesList.length === 1
          ? (point.status === 'BREACH' ? '#dc2626' : point.status === 'WARNING' ? '#d97706' : '#2563eb')
          : seriesColors[sIdx % seriesColors.length];

        return createEl('div', { className: 're-gbar-line' }, [
          createEl('span', { className: 're-gbar-sname', text: seriesList.length > 1 ? s.name : (point.invoiceCount !== undefined ? `${point.invoiceCount} inv` : '') }),
          createEl('div', { className: 're-gbar-track' }, [
            createEl('div', {
              className: 're-gbar-fill',
              style: { width: `${pct.toFixed(1)}%`, backgroundColor: color }
            })
          ]),
          createEl('span', { className: 're-gbar-val tabular-num', text: valText })
        ]);
      });

      return createEl('div', { className: 're-gbar-group' }, [
        createEl('div', { className: 're-gbar-cat-title', text: catLabel }),
        createEl('div', { className: 're-gbar-items' }, bars)
      ]);
    })
  );

  return createEl('div', { className: 're-grouped-chart-body' }, [legend, groupsEl]);
}

function renderLineChart(block) {
  const data = block.series?.[0]?.data || [];
  if (data.length < 2) return renderHBarChart(block);
  const values = data.map(d => Number(d.value || 0));
  const minVal = Math.min(...values) * 0.9;
  const maxVal = Math.max(...values, 1) * 1.05;
  const width = 560;
  const height = 180;
  const padX = 44;
  const padY = 24;

  const points = data.map((d, i) => {
    const x = padX + (i / (data.length - 1)) * (width - padX * 2);
    const y = height - padY - ((Number(d.value || 0) - minVal) / Math.max(1, maxVal - minVal)) * (height - padY * 2);
    return { x, y, label: d.label, value: Number(d.value || 0) };
  });

  const polylinePoints = points.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  const svg = createSvgEl('svg', {
    viewBox: `0 0 ${width} ${height}`,
    class: 're-line-svg',
    role: 'img',
    'aria-label': block.title || 'Trend line chart'
  });

  svg.appendChild(createSvgEl('polyline', {
    fill: 'none',
    stroke: '#2563eb',
    'stroke-width': '3',
    points: polylinePoints
  }));

  for (const p of points) {
    svg.appendChild(createSvgEl('circle', {
      cx: p.x.toFixed(1),
      cy: p.y.toFixed(1),
      r: '4.5',
      fill: '#1d4ed8'
    }));
    const labelText = createSvgEl('text', {
      x: p.x.toFixed(1),
      y: String(height - 6),
      'text-anchor': 'middle',
      fill: '#64748b',
      'font-size': '10'
    });
    labelText.textContent = p.label;
    svg.appendChild(labelText);
  }

  return createEl('div', { className: 're-line-chart-wrap' }, [svg]);
}

function renderChartBlock(block) {
  const chartType = block.chartType || 'hbar';
  let bodyNode;
  if (chartType === 'donut') {
    bodyNode = renderSvgDonutChart(block);
  } else if (chartType === 'groupedBar' || chartType === 'bar' || chartType === 'stacked') {
    bodyNode = renderGroupedOrVerticalBarChart(block);
  } else if (chartType === 'line') {
    bodyNode = renderLineChart(block);
  } else {
    bodyNode = renderHBarChart(block);
  }

  return createEl('div', { className: 'ai-chart-card re-chart-block' }, [
    createEl('div', { className: 'ai-chart-header' }, [
      createEl('div', { className: 're-chart-titles' }, [
        createEl('span', { className: 'ai-chart-title', text: block.title || 'Chart' }),
        block.subtitle ? createEl('span', { className: 're-chart-subtitle', text: block.subtitle }) : null
      ]),
      createValueKindBadge(block.valueKind)
    ]),
    bodyNode,
    block.caption ? createEl('div', { className: 're-chart-caption', text: block.caption }) : null
  ]);
}

function renderKeyValueBlock(block) {
  const items = Array.isArray(block.items) ? block.items : [];
  return createEl('div', { className: 're-kv-card' }, [
    block.title ? createEl('h4', { className: 're-block-title', text: block.title }) : null,
    createEl('div', { className: 're-kv-grid' },
      items.map(item => createEl('div', { className: 're-kv-item' }, [
        createEl('div', { className: 're-kv-label-row' }, [
          createEl('span', { className: 're-kv-label', text: item.label || '' }),
          createValueKindBadge(item.valueKind)
        ]),
        createEl('div', { className: 're-kv-value', text: String(item.value ?? '—') })
      ]))
    )
  ]);
}

function renderComparisonBlock(block) {
  const cols = Array.isArray(block.columns) ? block.columns : ['Metric', 'Current', 'Projected', 'Delta'];
  const rows = Array.isArray(block.rows) ? block.rows : [];

  const thead = createEl('thead', {}, [
    createEl('tr', {}, [
      ...cols.map((c, idx) => createEl('th', {
        className: idx === 0 ? 'text-left' : 'text-right',
        text: c
      })),
      createEl('th', { className: 'text-left', text: 'Basis' })
    ])
  ]);

  const tbody = createEl('tbody', {},
    rows.map(r => createEl('tr', { className: 'ai-table-row' }, [
      createEl('td', { className: 'text-left' }, [createEl('strong', { text: r.metric || '' })]),
      createEl('td', { className: 'text-right tabular-num', text: String(r.current ?? '—') }),
      createEl('td', { className: 'text-right tabular-num' }, [createEl('strong', { text: String(r.projected ?? '—') })]),
      createEl('td', { className: 'text-right tabular-num', text: String(r.delta ?? '—') }),
      createEl('td', { className: 'text-left' }, [createValueKindBadge(r.valueKind || (block.simulation ? 'SIMULATED' : 'CALCULATED'))])
    ]))
  );

  return createEl('div', { className: 're-comparison-block' }, [
    createEl('div', { className: 're-block-header' }, [
      createEl('h4', { className: 're-block-title', text: block.title || 'Current vs Projected Comparison' }),
      block.simulation
        ? createEl('span', { className: 'ai-badge badge-amber', text: 'SIMULATION – no data changed' })
        : null
    ]),
    createEl('div', { className: 'ai-table-wrap' }, [
      createEl('table', { className: 'ai-table' }, [thead, tbody])
    ])
  ]);
}

function renderRecommendationBlock(block, onFollowUpClick) {
  const decision = String(block.decision || 'MANUAL_REVIEW');
  const checks = Array.isArray(block.policyChecks) ? block.policyChecks : [];
  const reasons = Array.isArray(block.reasons) ? block.reasons : [];

  const checksList = createEl('div', { className: 're-policy-checks' },
    checks.map(chk => createEl('div', { className: 're-policy-check-row' }, [
      createBadgeEl(chk.status || 'WARN'),
      createEl('strong', { className: 're-policy-rule', text: chk.rule || '' }),
      createEl('span', { className: 're-policy-detail', text: chk.detail || '' })
    ]))
  );

  const reasonsList = reasons.length
    ? createEl('ul', { className: 'ai-list re-rec-reasons' },
        reasons.map(r => createEl('li', { text: r }))
      )
    : null;

  const draftBtn = block.draftAction && typeof onFollowUpClick === 'function'
    ? createEl('button', {
        className: 'button secondary re-draft-btn',
        text: block.draftAction.label || 'Draft limit request',
        attrs: { type: 'button' },
        onClick: () => onFollowUpClick(block.draftAction.prompt || block.draftAction.label, { fillOnly: true })
      })
    : null;

  return createEl('div', { className: 're-recommendation-card' }, [
    createEl('div', { className: 're-rec-header' }, [
      createEl('div', { className: 're-rec-title-group' }, [
        createEl('span', { className: 're-rec-label', text: 'Policy Recommendation:' }),
        createBadgeEl(decision)
      ]),
      createEl('span', { className: 'ai-badge badge-gray', text: 'ADVISORY ONLY · EXECUTED: FALSE' })
    ]),
    checksList,
    reasonsList,
    createEl('p', { className: 're-rec-advisory', text: block.advisoryNote || 'Advisory only; human approval is required.' }),
    draftBtn ? createEl('div', { className: 're-rec-actions' }, [draftBtn]) : null
  ]);
}

function renderAlertsBlock(block) {
  const items = Array.isArray(block.items) ? block.items : [];
  return createEl('div', { className: 're-alerts-block' }, [
    block.title ? createEl('h4', { className: 're-block-title', text: block.title }) : null,
    createEl('div', { className: 're-alerts-list' },
      items.map(item => {
        const sev = String(item.severity || 'warning').toUpperCase();
        return createEl('div', { className: `re-alert-card re-alert-${sev.toLowerCase()}` }, [
          createEl('div', { className: 're-alert-top' }, [
            createBadgeEl(sev),
            item.customerId ? createEl('code', { className: 'ai-id-chip', text: item.customerId }) : null,
            createEl('strong', { className: 're-alert-title', text: item.title || '' }),
            item.status ? createBadgeEl(item.status) : null
          ]),
          createEl('p', { className: 're-alert-desc', text: item.description || '' }),
          createEl('div', { className: 're-alert-footer' }, [
            item.recommendedAction
              ? createEl('span', { className: 're-alert-action', text: `Recommended action: ${item.recommendedAction}` })
              : null,
            item.detectedAt
              ? createEl('span', { className: 're-alert-time muted', text: `Detected: ${String(item.detectedAt).slice(0, 19).replace('T', ' ')}` })
              : null
          ])
        ]);
      })
    )
  ]);
}

function renderObservationsBlock(block) {
  const items = Array.isArray(block.items) ? block.items : [];
  if (!items.length) return null;
  return createEl('div', { className: 're-observations-block' }, [
    createEl('h4', { className: 're-block-title', text: block.title || 'Key Observations & Actions' }),
    createEl('ul', { className: 'ai-list' },
      items.map(item => createEl('li', { text: item }))
    )
  ]);
}

function renderHeadlineBulletContent(bulletText) {
  const str = String(bulletText ?? '').trim();
  const frag = createEl('span', { className: 're-bullet-text', text: str });
  return frag;
}

function renderBlockByType(block, onFollowUpClick) {
  if (!block || typeof block !== 'object') return null;
  switch (block.type) {
    case 'text':
      return renderTextBlock(block);
    case 'metrics':
      return renderMetricsBlock(block);
    case 'table':
      return renderTableBlock(block);
    case 'chart':
      return renderChartBlock(block);
    case 'alerts':
      return renderAlertsBlock(block);
    case 'keyValue':
      return renderKeyValueBlock(block);
    case 'comparison':
      return renderComparisonBlock(block);
    case 'recommendation':
      return renderRecommendationBlock(block, onFollowUpClick);
    case 'observations':
      return renderObservationsBlock(block);
    case 'notice':
      return renderNoticeBlock(block);
    default:
      return null;
  }
}

const MINIMAL_CONVERSATIONAL_INTENTS = new Set([
  'GREETING',
  'HOW_ARE_YOU',
  'THANKS',
  'GOODBYE',
  'HELP',
  'OFF_TOPIC',
  'OUT_OF_SCOPE',
  'CLARIFY',
  'UNKNOWN'
]);

const ABOVE_FOLD_TABLE_INTENTS = new Set([
  'CUSTOMER_LIST',
  'UTILISATION_LIST',
  'HIGH_RISK_CUSTOMERS',
  'CUSTOMERS_NO_LIMIT',
  'OVERDUE_COLLECTIONS',
  'EXPOSURE_BY_COUNTRY',
  'EXPOSURE_BY_COMPANY_CODE',
  'DATA_SOURCES_STATUS',
  'DATA_EXTRACTION_TIMELINE',
  'CDS_ENTITIES_LIST',
  'LIMIT_APPROVALS_STATUS',
  'MONITORING_ALERTS',
  'AUDIT_HISTORY',
  'WORKSPACE_QUERY'
]);

export function renderStructuredResponseDOM(structured, { onFollowUpClick } = {}) {
  if (!structured || typeof structured !== 'object') return null;

  const primaryIntent = structured.intent?.primary || 'UNKNOWN';
  const isMinimalIntent = MINIMAL_CONVERSATIONAL_INTENTS.has(primaryIntent);

  const container = createEl('div', {
    className: `structured-assistant-reply re-response-root${isMinimalIntent ? ' re-response-minimal' : ''}`,
    dataset: { intent: primaryIntent }
  });

  // Minimal / conversational / off-topic / help / clarify intents: ZERO data badges, ZERO data tables
  if (isMinimalIntent) {
    if (structured.summary) {
      container.appendChild(createEl('p', {
        className: 'ai-paragraph ai-summary-sentence re-headline-answer',
        text: structured.summary
      }));
    }

    if (primaryIntent === 'HELP' && Array.isArray(structured.helpGroups) && structured.helpGroups.length > 0) {
      container.appendChild(createEl('div', { className: 're-help-groups' },
        structured.helpGroups.map(group => createEl('div', { className: 're-help-group-item' }, [
          createEl('strong', { className: 're-help-group-title', text: group.title || '' }),
          createEl('span', { className: 're-help-group-desc', text: group.description || '' })
        ]))
      ));
    }

    if (primaryIntent === 'CLARIFY' && structured.clarifyTip) {
      container.appendChild(createEl('p', {
        className: 're-clarify-tip muted',
        text: structured.clarifyTip
      }));
    }

    const chipCap = primaryIntent === 'HELP' ? 6 : (primaryIntent === 'OFF_TOPIC' || primaryIntent === 'OUT_OF_SCOPE') ? 4 : 3;
    const followUps = Array.isArray(structured.suggestedFollowUps)
      ? structured.suggestedFollowUps.slice(0, chipCap)
      : [];
    if (followUps.length > 0) {
      const chipLabel = primaryIntent === 'CLARIFY'
        ? 'Did you mean:'
        : primaryIntent === 'HELP'
          ? 'Try asking:'
          : 'Try asking one of these:';
      container.appendChild(createEl('div', { className: 're-followups-row re-followups-minimal' }, [
        createEl('span', { className: 're-followups-label', text: chipLabel }),
        createEl('div', { className: 're-followups-chips' },
          followUps.map(q => createEl('button', {
            className: 'prompt-chip re-followup-chip',
            text: q,
            attrs: { type: 'button' },
            onClick: () => {
              if (typeof onFollowUpClick === 'function') {
                onFollowUpClick(q, { fillOnly: /^Draft limit request/i.test(q) });
              }
            }
          }))
        )
      ]));
    }
    return container;
  }

  // 1. Context resolution banner (if entities were resolved from conversation memory)
  if (structured.intent?.resolvedFromContext && structured.intent?.contextNote) {
    container.appendChild(createEl('div', { className: 're-context-pill' }, [
      createEl('span', { text: structured.intent.contextNote })
    ]));
  }

  // 2. 1-line headline answer + optional plan mapping note (e.g. country code = company code)
  if (structured.summary) {
    container.appendChild(createEl('p', {
      className: 'ai-paragraph ai-summary-sentence re-headline-answer',
      text: structured.summary
    }));
  }
  if (structured.planNote) {
    container.appendChild(createEl('p', {
      className: 're-plan-note muted',
      text: structured.planNote
    }));
  }

  const headlineBullets = Array.isArray(structured.headlineBullets)
    ? structured.headlineBullets.filter(Boolean).slice(0, 5)
    : [];
  const blocks = Array.isArray(structured.blocks) ? structured.blocks : [];

  const renderPrimaryBlockAboveFold = structured.showTableAboveFold !== undefined
    ? Boolean(structured.showTableAboveFold)
    : ABOVE_FOLD_TABLE_INTENTS.has(primaryIntent);
  const renderedBlockIndices = new Set();

  // 3. Above-the-fold primary content (either metrics/table directly for list/evaluation intents, or up to 5 bullets + metrics)
  if (headlineBullets.length > 0) {
    container.appendChild(createEl('ul', { className: 'ai-list re-headline-bullets' },
      headlineBullets.map(b => createEl('li', {}, [renderHeadlineBulletContent(b)]))
    ));
  }
  const firstMetricsIdx = blocks.findIndex(b => b && b.type === 'metrics');
  if (firstMetricsIdx !== -1) {
    const node = renderBlockByType(blocks[firstMetricsIdx], onFollowUpClick);
    if (node) {
      container.appendChild(node);
      renderedBlockIndices.add(firstMetricsIdx);
    }
  }

  if (structured.navigationAction?.tabId) {
    const navTab = structured.navigationAction.tabId;
    const navLabel = structured.navigationAction.label || `Open ${navTab}`;
    container.appendChild(createEl('div', { className: 're-nav-action-row' }, [
      createEl('button', {
        className: 'button primary re-nav-btn',
        text: navLabel,
        attrs: { type: 'button', 'data-open-tab': navTab },
        onClick: () => {
          if (typeof window !== 'undefined' && typeof window.switchTab === 'function') {
            window.switchTab(navTab);
          } else if (typeof document !== 'undefined') {
            const tabBtn = document.querySelector(`[data-tab="${navTab}"]`);
            if (tabBtn && typeof tabBtn.click === 'function') tabBtn.click();
          }
        }
      })
    ]));
  }

  if (renderPrimaryBlockAboveFold) {
    const primaryIdx = blocks.findIndex((b, idx) =>
      !renderedBlockIndices.has(idx) && b && ['table', 'alerts', 'keyValue', 'comparison', 'recommendation'].includes(b.type)
    );
    if (primaryIdx !== -1) {
      const primaryNode = renderBlockByType(blocks[primaryIdx], onFollowUpClick);
      if (primaryNode) {
        container.appendChild(primaryNode);
        renderedBlockIndices.add(primaryIdx);
      }
    }
  }

  // 4. Secondary blocks, charts, formulas, and provenance inside collapsed "Show details"
  const detailsBodyChildren = [];

  if (structured.title) {
    detailsBodyChildren.push(createEl('h4', { className: 'ai-heading-3 re-answer-title', text: structured.title }));
  }

  blocks.forEach((block, idx) => {
    if (renderedBlockIndices.has(idx)) return;
    const blockNode = renderBlockByType(block, onFollowUpClick);
    if (blockNode) detailsBodyChildren.push(blockNode);
  });

  const assumptions = Array.isArray(structured.assumptions) ? structured.assumptions : [];
  const limitations = Array.isArray(structured.limitations) ? structured.limitations : [];
  if (assumptions.length > 0 || limitations.length > 0) {
    const items = [
      ...assumptions.map(a => `Assumption: ${a}`),
      ...limitations.map(l => `Limitation: ${l}`)
    ];
    detailsBodyChildren.push(createEl('div', { className: 're-assumptions-inline' }, [
      createEl('h5', { className: 're-block-title', text: `Assumptions & Limitations (${items.length})` }),
      createEl('ul', { className: 'ai-list' }, items.map(t => createEl('li', { text: t })))
    ]));
  }

  const prov = structured.dataProvenance || {};
  const toolsList = Array.isArray(prov.toolsInvoked) && prov.toolsInvoked.length
    ? prov.toolsInvoked.join(', ')
    : 'Deterministic Policy Engine';
  detailsBodyChildren.push(createEl('div', { className: 're-provenance-inline' }, [
    createEl('div', { className: 're-provenance-inline-header' }, [
      createEl('span', { className: 'ai-badge badge-amber', text: 'DEMO DATA' }),
      createEl('span', { className: 're-kind-badge re-kind-calculated', text: 'CALCULATED' }),
      createEl('span', { className: 're-prov-title-text', text: `Data Provenance · ${prov.sourceType || 'SYNTHETIC_DEMO'} · Policy ${prov.policyId || 'FIN-FSCM-AUTONOMOUS-POLICY-V1'}` })
    ]),
    createEl('p', {
      className: 're-prov-line',
      text: `Connector: ${prov.connectorName || 'Credit Guard Demo Dataset'} · Currency: ${prov.currency || 'INR'} · Tools Invoked: ${toolsList} · Snapshot: ${String(prov.lastSyncAt || '').slice(0, 19).replace('T', ' ')}`
    })
  ]));

  if (detailsBodyChildren.length > 0) {
    container.appendChild(createEl('details', { className: 're-show-details' }, [
      createEl('summary', { className: 're-show-details-summary' }, [
        createEl('span', { className: 're-show-details-label', text: 'Show details' }),
        createEl('span', { className: 're-show-details-hint', text: 'Charts, formulas & audit provenance' })
      ]),
      createEl('div', { className: 're-show-details-body' }, detailsBodyChildren)
    ]));
  }

  // 5. Source & Freshness Footer ("Source: <tab name> · Data as of <time>")
  const sourceLabel = structured.sourceTabLabel || 'AI Credit Assistance';
  const asOfLabel = structured.dataAsOf || (prov.lastSyncAt ? String(prov.lastSyncAt).slice(0, 19).replace('T', ' ') : 'current session');
  container.appendChild(createEl('p', {
    className: 're-source-footer muted',
    text: `Source: ${sourceLabel} · Data as of ${asOfLabel}`
  }));

  // 6. Clickable Suggested Follow-Up Chips (up to 3)
  const followUps = Array.isArray(structured.suggestedFollowUps) ? structured.suggestedFollowUps.slice(0, 3) : [];
  if (followUps.length > 0) {
    container.appendChild(createEl('div', { className: 're-followups-row' }, [
      createEl('span', { className: 're-followups-label', text: 'Suggested follow-ups:' }),
      createEl('div', { className: 're-followups-chips' },
        followUps.map(q => createEl('button', {
          className: 'prompt-chip re-followup-chip',
          text: q,
          attrs: { type: 'button' },
          onClick: () => {
            if (typeof onFollowUpClick === 'function') {
              onFollowUpClick(q, { fillOnly: /^Draft limit request/i.test(q) });
            }
          }
        }))
      )
    ]));
  }

  return container;
}
