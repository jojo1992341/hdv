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

### 3) Installer `pytesseract` et les dépendances Python

```bash
pip install -r requirements.txt
```

> `pytesseract` (package Python) est installé par `requirements.txt`.

### 4) Installer le binaire **Tesseract OCR** (obligatoire)

`pytesseract` est un wrapper Python : il faut aussi installer l’exécutable système `tesseract`.

**Vérifier l'installation**

```bash
tesseract --version
```

#### Ubuntu / Debian

```bash
sudo apt update
sudo apt install -y tesseract-ocr tesseract-ocr-fra
```

#### Fedora

```bash
sudo dnf install -y tesseract tesseract-langpack-fra
```

#### Arch Linux

```bash
sudo pacman -S tesseract tesseract-data-fra
```

#### macOS (Homebrew)

```bash
brew install tesseract
```

> Sur macOS, si le français n’est pas présent, installer aussi les données de langue via les packs Homebrew disponibles.

#### Windows

- Installer **Tesseract OCR** (ex: UB Mannheim build).
- Ajouter le dossier d’installation (contenant `tesseract.exe`) au `PATH`.
- Redémarrer le terminal puis vérifier :

```bat
tesseract --version
```

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
