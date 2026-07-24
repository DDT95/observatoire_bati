# Observatoire du bâti du Val-d’Oise — V24

## Correctif QPV

La fiche HTML n’utilise plus une couche géographique externe pour déterminer
l’appartenance à un QPV.

La valeur est lue directement dans les données BDNB / RPLS :

```text
dans_qpv
```

Cette source est la même que celle visible dans le PDF.

La fiche affiche désormais :

- **Dans un quartier prioritaire**
- **Hors quartier prioritaire**
- **Information non disponible**

Aucune couche QPV n’est affichée sur la carte dans cette version.


## Correctif V25 — stabilité BDNB sur GitHub Pages

- suppression des dix requêtes BDNB lancées simultanément ;
- chargement séquentiel des tables, avec une courte temporisation ;
- trois nouvelles tentatives automatiques en cas de réponse 429 ou 503 ;
- respect de l’en-tête `Retry-After` lorsqu’il est fourni ;
- cache navigateur de 30 minutes par ID-RNB ;
- mutualisation des clics simultanés sur le même bâtiment ;
- affichage des réponses partielles au lieu de jeter toute la fiche ;
- voyant « API très sollicitée » plutôt que « indisponible » en cas de limitation temporaire.
