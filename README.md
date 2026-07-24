# Observatoire du bâti — V28

Correctif construit à partir du journal Réseau du navigateur.

## Constats observés

- `rel_batiment_construction_rnb` répondait 404 ;
- `batiment_construction?rnb_id=...` répondait 200 ;
- `batiment_groupe_complet?batiment_groupe_id=...` répondait 200.

## Corrections

- suppression complète de la route en erreur 404 ;
- rapprochement direct via `batiment_construction?rnb_id=...` ;
- lecture des réponses BDNB sous forme de tableau ou d’objet JSON ;
- nouveau namespace de cache pour ignorer les anciennes réponses ;
- maintien du correctif PDF QPV ;
- syntaxe JavaScript validée avec Node.
