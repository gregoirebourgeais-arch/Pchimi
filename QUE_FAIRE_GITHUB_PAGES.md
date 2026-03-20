# Que faire sur l'écran GitHub Pages (celui de ta capture)

Tu es au bon endroit.

## Ce qu'il faut faire
1. Vérifie que `Source` est bien sur **GitHub Actions**.
2. **Ne clique pas** sur les boutons `Configure` (Jekyll / Static HTML). Ce ne sont pas les bons workflows pour ton app React.
3. Retourne sur ton dépôt.
4. Fais un commit + push sur la branche `main`.
5. Va dans l'onglet `Actions` et attends le workflow **Deploy frontend to GitHub Pages**.
6. Quand il est vert (succès), recharge ton URL GitHub Pages.

## Si aucun workflow n'apparaît dans Actions
- Vérifie que le fichier `.github/workflows/deploy-pages.yml` est bien sur `main`.
- Vérifie que GitHub Actions est autorisé dans les paramètres du repo.

## Si le workflow échoue
Ouvre le run et envoie-moi la première erreur rouge.
