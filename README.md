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
