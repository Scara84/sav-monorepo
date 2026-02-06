export function buildSavHtmlTable(forms, items) {
  let html =
    `<table border="1" cellpadding="5" cellspacing="0" style="border-collapse:collapse;">` +
    `<tr>` +
    `<th>Désignation</th>` +
    `<th>Quantité demandée</th>` +
    `<th>Quantité facturée</th>` +
    `<th>Unité demandée</th>` +
    `<th>Unité facturée</th>` +
    `<th>Motif</th>` +
    `<th>Commentaire</th>` +
    `<th>Prix Unitaire</th>` +
    `<th>Prix Total</th>` +
    `<th>Images</th>` +
    `</tr>`;

  forms.forEach(({ form, index }) => {
    const item = items[index] || {};
    const images = (form.images || [])
      .map((img) =>
        img.uploadedUrl ? `<a href="${img.uploadedUrl}">${img.file ? img.file.name : ''}</a>` : ''
      )
      .join('<br>');

    html +=
      `<tr>` +
      `<td>${item.label || ''}</td>` +
      `<td>${form.quantity || ''}</td>` +
      `<td>${item.quantity || ''}</td>` +
      `<td>${form.unit || ''}</td>` +
      `<td>${item.unit || ''}</td>` +
      `<td>${form.reason || ''}</td>` +
      `<td>${form.comment || ''}</td>` +
      `<td>${
        item.amount && item.quantity
          ? (item.amount / item.quantity).toLocaleString('fr-FR', {
              style: 'currency',
              currency: 'EUR',
            })
          : ''
      }</td>` +
      `<td>${
        item.amount
          ? item.amount.toLocaleString('fr-FR', {
              style: 'currency',
              currency: 'EUR',
            })
          : ''
      }</td>` +
      `<td>${images}</td>` +
      `</tr>`;
  });

  html += `</table>`;
  return html;
}
