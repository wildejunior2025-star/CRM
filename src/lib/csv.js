function escapeCsvValue(value) {
  const str = value === null || value === undefined ? '' : String(value)
  if (/[",\n;]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`
  }
  return str
}

export function exportToCsv(filename, columns, rows) {
  const header = columns.map((c) => escapeCsvValue(c.label)).join(';')
  const lines = rows.map((row) =>
    columns.map((c) => escapeCsvValue(c.value(row))).join(';')
  )
  const csv = [header, ...lines].join('\r\n')

  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(url)
}
