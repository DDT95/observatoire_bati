# Observatoire du bâti du Val-d’Oise — V26 stable

## Architecture BDNB

Chaque sélection de bâtiment déclenche au maximum :

1. une requête de relation ID-RNB → groupe BDNB ;
2. une requête vers `batiment_groupe_complet`.

La réponse complète est ensuite répartie localement dans les rubriques DPE, RPLS,
copropriété, risques, usages, rénovation et caractéristiques physiques.

- aucun appel parallèle aux dix tables métier ;
- cache navigateur d’une heure ;
- mutualisation des clics simultanés ;
- nouvelles tentatives automatiques pour les erreurs 429/503 ;
- cadastre, DVF et Sitadel restent indépendants de la BDNB.
