# Coffre — extension Chrome (remplissage auto)

Remplit identifiant + mot de passe depuis ton coffre, sur desktop (Chrome/Edge/Brave).

## Installer (mode développeur)
1. Ouvre `chrome://extensions`.
2. Active **Mode développeur** (en haut à droite).
3. **Charger l’extension non empaquetée** → sélectionne ce dossier `extension/`.
4. Épingle l’icône 🔐 dans la barre.

## Utiliser
1. Dans l’app **Coffre** → ⚙️ Réglages → **Exporter (chiffré)** : tu obtiens un `.json`.
2. Dans l’extension (popup) → **Choisir le fichier .json** pour l’importer une fois.
3. **Déverrouille** avec ton mot de passe maître (vérif IP France/VPN incluse).
4. Sur une page de connexion : ouvre le popup → l’entrée du site est mise en avant
   (badge « ce site ») → **Remplir** (ou **+ Entrée** pour valider), ou copie 👤 / 🔑.
5. Raccourci **Ctrl+Shift+L** (Cmd+Shift+L sur Mac) : remplit directement l’entrée
   correspondant au site, si le coffre est déverrouillé.

## Sécurité
- L’extension garde **sa propre copie chiffrée** (import) ; rien n’est partagé avec
  un serveur. Les mots de passe déchiffrés vivent en mémoire de session
  (`chrome.storage.session`), effacés à la fermeture du navigateur, et
  auto-verrouillage après 5 min.
- Après avoir modifié des entrées dans l’app, **ré-exporte** et **réimporte** pour
  mettre l’extension à jour (pas de synchro automatique — c’est volontaire, zéro serveur).
- Le remplissage cherche le champ mot de passe visible puis l’identifiant associé ;
  sur des formulaires exotiques, utilise **Copier** 👤/🔑.
