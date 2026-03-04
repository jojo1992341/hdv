# Outil de flip HDV (Dofus) à partir d'images

Cette application web permet d'uploader :
1. un screenshot du **graphique de vente** d'une ressource,
2. un screenshot des **prix en HDV**,

puis calcule si l'achat/revente est rentable et propose un prix de revente cible.

## Installation

### 1) Créer l'environnement virtuel

```bash
python -m venv .venv
```

### 2) Activer l'environnement virtuel

**Linux / macOS (bash/zsh)**

```bash
source .venv/bin/activate
```

**Windows (PowerShell)**

```powershell
.\.venv\Scripts\Activate.ps1
```

**Windows (Invite de commandes / cmd.exe)**

```bat
.venv\Scripts\activate.bat
```

### 3) Installer les dépendances

```bash
pip install -r requirements.txt
```

⚠️ `pytesseract` nécessite aussi le binaire Tesseract installé sur la machine (`tesseract --version`).

## Lancer

```bash
python app.py
```

Puis ouvrir `http://localhost:8000`.

## Hypothèses de calcul

- Prix de revente cible = `(0.7 * prix_médian + 0.3 * prix_moyen) * 0.98`
- Frais de mise en vente configurables (2% par défaut)
- Analyse pour chaque lot détecté (1/10/100/1000)

## Tests

```bash
python -m unittest discover -s tests -v
```
