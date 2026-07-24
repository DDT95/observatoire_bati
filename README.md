# Observatoire du bâti du Val-d’Oise — V27 corrigée

## Correction BDNB

La relation BDNB correcte est :

1. `rel_batiment_construction_rnb` : ID-RNB → `batiment_construction_id`
2. `batiment_construction` : `batiment_construction_id` → `batiment_groupe_id`
3. `batiment_groupe_complet` : chargement de la fiche complète

La version précédente cherchait à tort `batiment_groupe_id` dans la première table.

## Correction PDF

La valeur `isInQpv` est maintenant recalculée dans la fonction d’export à partir
de `dans_qpv` fourni par la BDNB / RPLS. L’erreur JavaScript n’existe plus.

## Déploiement GitHub Pages

Remplacer :

- `index.html`
- `app.js`
- `styles.css`

Puis valider le commit et effectuer `Ctrl + F5`.
