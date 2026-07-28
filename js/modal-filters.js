// ── Sistema reutilizable de filtros en modales ──
// Inserta una barra de <select> sobre la tabla del modal, filtra las filas y
// actualiza el subtítulo con countLabel(n). Cada nivel de modal (drill-down)
// llama a esto de forma independiente, con su propio containerId.
//
//   renderModalFilters({ containerId, subtitleId, tableBodyId, rows, filters, renderRow, countLabel })
//
// filters: [{ id, label, field, allLabel }]
//   field: nombre de propiedad del objeto row, o función row => valor.

export function renderModalFilters({ containerId, subtitleId, tableBodyId, rows, filters, renderRow, countLabel }) {
  const tbody = document.getElementById(tableBodyId);
  if (!tbody) return;
  const table = tbody.closest('table');

  // Barra de filtros — se crea (o reutiliza) encima de la tabla
  let bar = containerId ? document.getElementById(containerId) : null;
  if (!bar) {
    bar = document.createElement('div');
    if (containerId) bar.id = containerId;
    if (table && table.parentNode) table.parentNode.insertBefore(bar, table);
  }
  bar.className = 'modal-filter-bar';
  bar.innerHTML = '';

  const valOf = (row, f) => {
    const raw = typeof f.field === 'function' ? f.field(row) : row[f.field];
    return (raw === null || raw === undefined) ? '' : String(raw).trim();
  };

  const selects = (filters || []).map(f => {
    const uniq = [...new Set(rows.map(r => valOf(r, f)).filter(v => v !== ''))]
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
    const label = document.createElement('label');
    label.textContent = f.label;
    bar.appendChild(label);
    const sel = document.createElement('select');
    if (f.id) sel.id = f.id;
    const optAll = document.createElement('option');
    optAll.value = '';
    optAll.textContent = f.allLabel || 'All';
    sel.appendChild(optAll);
    uniq.forEach(v => {
      const o = document.createElement('option');
      o.value = v;
      o.textContent = v;
      sel.appendChild(o);
    });
    bar.appendChild(sel);
    return { f, sel };
  });

  const clearBtn = document.createElement('button');
  clearBtn.type = 'button';
  clearBtn.className = 'modal-filter-clear';
  clearBtn.innerHTML = '&#10005; Clear filters';
  bar.appendChild(clearBtn);

  const sub = subtitleId ? document.getElementById(subtitleId) : null;

  const apply = () => {
    const active = selects.filter(({ sel }) => sel.value !== '');
    const filtered = active.length
      ? rows.filter(row => active.every(({ f, sel }) => valOf(row, f) === sel.value))
      : rows;
    tbody.innerHTML = filtered.map(renderRow).join('');
    if (sub && typeof countLabel === 'function') sub.textContent = countLabel(filtered.length);
    clearBtn.classList.toggle('visible', active.length > 0);
  };

  selects.forEach(({ sel }) => sel.addEventListener('change', apply));
  clearBtn.addEventListener('click', () => { selects.forEach(({ sel }) => sel.value = ''); apply(); });

  apply();
}
