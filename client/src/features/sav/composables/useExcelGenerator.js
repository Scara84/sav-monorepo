import * as XLSX from 'xlsx';

/**
 * Composable pour générer des fichiers Excel
 * Extrait la logique de génération Excel de WebhookItemsList
 */
export function useExcelGenerator() {
  
  /**
   * Sépare le code article du nom du produit
   */
  const splitProductLabel = (label) => {
    if (!label) return { code: '', name: '' };
    
    // Recherche le premier espace qui sépare le code du nom
    const firstSpaceIndex = label.indexOf(' ');
    if (firstSpaceIndex === -1) return { code: label, name: '' };
    
    // Le code est tout ce qui est avant le premier espace
    const code = label.substring(0, firstSpaceIndex);
    // Le nom est tout ce qui est après le premier espace
    const name = label.substring(firstSpaceIndex + 1);
    
    return { code, name };
  };

  /**
   * Formate une adresse pour l'affichage
   */
  const formatAddress = (addr) => {
    if (!addr || (!addr.address && !addr.city)) return 'N/A';
    const parts = [addr.address, addr.postal_code, addr.city, addr.country_alpha2].filter(Boolean);
    return parts.join(', ');
  };

  /**
   * Génère un fichier Excel avec les données SAV
   */
  const generateExcelFile = (forms, items, facture) => {
    const wb = XLSX.utils.book_new();

    // --- Onglet 1: Réclamations SAV ---
    const headers = [
      'PRENOM NOM',
      'DESIGNATION',
      'QTE',
      'UNITE',
      'CAUSE',
      'AVOIR %',
      'COMMENTAIRE',
      'CODE ARTICLE',
      'PRIX UNIT'
    ];

    const savData = forms.map(({ form, index }) => {
      const item = items[index] || {};
      const { code, name } = splitProductLabel(item.label);
      const unitPrice = (item.amount && item.quantity) ? (item.amount / item.quantity) : undefined;
      return {
        'PRENOM NOM': facture.customer?.name || '',
        'DESIGNATION': name,
        'QTE': form.quantity || '',
        'UNITE': form.unit || '',
        'CAUSE': form.reason === 'abime' ? 'ABIME' :
                 form.reason === 'casse' ? 'CASSE' :
                 form.reason === 'manquant' ? 'MANQUANT' :
                 form.reason === 'erreur' ? 'ERREUR DE PREPARATION' : '',
        'AVOIR %': form.creditPercentage || '',
        'COMMENTAIRE': form.comment || '',
        'CODE ARTICLE': code,
        'PRIX UNIT': unitPrice
      };
    });

    const wsSav = XLSX.utils.json_to_sheet(savData, { header: headers });
    wsSav['!cols'] = [
      { wch: 25 }, // PRENOM NOM
      { wch: 50 }, // DESIGNATION
      { wch: 10 }, // QTE
      { wch: 10 }, // UNITE
      { wch: 20 }, // CAUSE
      { wch: 10 }, // AVOIR %
      { wch: 50 }, // COMMENTAIRE
      { wch: 15 }, // CODE ARTICLE
      { wch: 15 }  // PRIX UNIT
    ];
    XLSX.utils.book_append_sheet(wb, wsSav, 'Réclamations SAV');

    // --- Onglet 2: Informations Client ---
    const specialMention = facture.special_mention || '';
    let orderNumber = '';
    if (specialMention) {
      const lastIndex = specialMention.lastIndexOf('_');
      if (lastIndex !== -1) {
        orderNumber = specialMention.substring(0, lastIndex);
      } else {
        orderNumber = specialMention;
      }
    }

    const customerData = [
      { 'Propriété': 'ID Client', 'Valeur': facture.customer?.source_id || 'N/A' },
      { 'Propriété': 'Nom du client', 'Valeur': facture.customer?.name || 'N/A' },
      { 'Propriété': 'Email du client', 'Valeur': facture.customer?.emails?.[0] || 'N/A' },
      { 'Propriété': 'Téléphone du client', 'Valeur': facture.customer?.phone || 'N/A' },
      { 'Propriété': 'Adresse de livraison', 'Valeur': formatAddress(facture.customer?.delivery_address) },
      { 'Propriété': 'Adresse de facturation', 'Valeur': formatAddress(facture.customer?.billing_address) },
      { 'Propriété': 'Numéro de facture', 'Valeur': facture.invoice_number || 'N/A' },
      { 'Propriété': 'Date de facture', 'Valeur': facture.date || 'N/A' },
      { 'Propriété': 'Mention spéciale', 'Valeur': specialMention },
      { 'Propriété': 'Numéro de commande', 'Valeur': orderNumber },
    ];
    const wsCustomer = XLSX.utils.json_to_sheet(customerData, { skipHeader: true });
    wsCustomer['!cols'] = [{ wch: 30 }, { wch: 50 }];
    XLSX.utils.book_append_sheet(wb, wsCustomer, 'Infos Client');

    // --- Onglet 3: SAV (tableau mix réclamations + mail) ---
    const savTableHeaders = [
      'PRENOM NOM',
      'DESIGNATION',
      'Quantité demandée',
      'Unité demandée',
      'Quantité facturée',
      'Unité facturée',
      'Motif',
      'Commentaire',
      'Prix Unitaire',
      'Prix Total',
      'Images'
    ];

    // Fonction pour formater les nombres avec virgule (format FR)
    const formatNumberFR = (num) => {
      if (num === '' || num === null || num === undefined) return '';
      return String(num).replace('.', ',');
    };

    const savTableData = forms.map(({ form, index }) => {
      const item = items[index] || {};
      const { code, name } = splitProductLabel(item.label);
      const unitPrice = (item.amount && item.quantity) ? (item.amount / item.quantity) : '';
      const totalPrice = item.amount || '';
      
      // Formater les liens des images
      const imagesLinks = (form.images || [])
        .map(img => img.uploadedUrl || '')
        .filter(url => url)
        .join('\n');

      return {
        'PRENOM NOM': facture.customer?.name || '',
        'DESIGNATION': name,
        'Quantité demandée': formatNumberFR(form.quantity || ''),
        'Unité demandée': form.unit || '',
        'Quantité facturée': formatNumberFR(item.quantity || ''),
        'Unité facturée': item.unit || '',
        'Motif': form.reason || '',
        'Commentaire': form.comment || '',
        'Prix Unitaire': formatNumberFR(unitPrice),
        'Prix Total': formatNumberFR(totalPrice),
        'Images': imagesLinks
      };
    });

    const wsSavTable = XLSX.utils.json_to_sheet(savTableData, { header: savTableHeaders });
    wsSavTable['!cols'] = [
      { wch: 25 }, // PRENOM NOM
      { wch: 50 }, // DESIGNATION
      { wch: 18 }, // Quantité demandée
      { wch: 15 }, // Unité demandée
      { wch: 18 }, // Quantité facturée
      { wch: 15 }, // Unité facturée
      { wch: 20 }, // Motif
      { wch: 50 }, // Commentaire
      { wch: 15 }, // Prix Unitaire
      { wch: 15 }, // Prix Total
      { wch: 60 }  // Images
    ];
    XLSX.utils.book_append_sheet(wb, wsSavTable, 'SAV');
    
    // Convertir en base64
    const excelBuffer = XLSX.write(wb, { bookType: 'xlsx', type: 'base64' });
    return excelBuffer;
  };

  return {
    generateExcelFile,
    splitProductLabel,
    formatAddress
  };
}
