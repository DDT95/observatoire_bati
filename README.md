# Observatoire du bâti — V22 QPV locaux dans la fiche

Les 42 périmètres QPV fournis par la DDT95 sont intégrés directement dans `app.js`.

Ajouts :

- légende légère permanente sur la carte ;
- statut du bâtiment calculé par point-dans-polygone ;
- affichage « Dans le QPV : nom » ou « Hors QPV » ;
- carte QPV dans la synthèse du bâtiment ;
- aucune API QPV externe.

Les fonctions BDNB, DPE, RPLS, cadastre, DVF, Sitadel et PDF ne sont pas réécrites.


## Correctif
La légende QPV est forcée sur une seule ligne.
