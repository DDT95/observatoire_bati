# Observatoire du bâti du Val-d’Oise — GitHub Pages

Version statique compatible GitHub Pages.

## Fichiers à déposer à la racine du dépôt

- `index.html`
- `app.js`
- `styles.css`
- `.nojekyll`
- `404.html`

Le dossier peut aussi contenir ce `README.md`.

## Publication

Dans GitHub :

1. Ouvrir **Settings**
2. Ouvrir **Pages**
3. Dans **Build and deployment**, choisir **Deploy from a branch**
4. Sélectionner la branche `main`
5. Sélectionner le dossier `/ (root)`
6. Enregistrer

L’adresse sera de la forme :

```text
https://ddt95.github.io/observatoire_bati/
```

## Important

GitHub Pages ne prend pas en charge PHP. Cette version utilise donc directement,
depuis le navigateur :

- API RNB
- API BDNB
- API Carto Cadastre IGN
- DVF+ Cerema
- Sitadel / DiDo
- QPV / ANCT

Si un service bloque les appels CORS depuis GitHub Pages, son voyant apparaîtra en rouge
ou en connexion partielle. Le reste de l’observatoire continuera de fonctionner.

## Mise à jour

Pour remplacer la version publiée :

1. supprimer ou écraser les anciens fichiers ;
2. envoyer les nouveaux fichiers ;
3. valider avec **Commit changes** ;
4. attendre généralement une à deux minutes.
