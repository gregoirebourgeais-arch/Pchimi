# Comment faire un push sur `main` (Windows)

## Option la plus simple (sans ligne de commande)
1. Ouvre **GitHub Desktop**.
2. Ouvre ton dépôt.
3. Clique **Fetch origin**.
4. En haut, vérifie que la branche est `main`.
5. Si ce n'est pas `main`, change de branche vers `main`.
6. Clique **Commit to main**.
7. Clique **Push origin**.

## Option terminal (si tu veux)
```bash
git checkout main
git pull origin main
git add .
git commit -m "Mise a jour menu planner"
git push origin main
```

## Si `git push` échoue
- Message d'authentification: reconnecte ton compte GitHub dans GitHub Desktop.
- Message "rejected": fais d'abord `git pull origin main`, puis recommence.
