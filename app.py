from io import BytesIO

from flask import Flask, render_template, request
from PIL import Image
import pytesseract

from src.hdv_analyzer import analyze_flip, extract_hdv_offers, extract_market_metrics

app = Flask(__name__)


def ocr_image(image_bytes: bytes) -> str:
    image = Image.open(BytesIO(image_bytes)).convert("L")
    return pytesseract.image_to_string(image, lang="fra+eng")


@app.route("/", methods=["GET", "POST"])
def index():
    context = {"error": None, "result": None, "graph_ocr": None, "hdv_ocr": None}

    if request.method == "POST":
        try:
            graph_file = request.files.get("graph_image")
            hdv_file = request.files.get("hdv_image")
            fee_rate = float(request.form.get("fee_rate", "2")) / 100

            if not graph_file or not hdv_file:
                raise ValueError("Merci de fournir les 2 images (graphique + HDV).")

            graph_text = ocr_image(graph_file.read())
            hdv_text = ocr_image(hdv_file.read())

            metrics = extract_market_metrics(graph_text)
            offers = extract_hdv_offers(hdv_text)
            recommendation = analyze_flip(metrics, offers, fee_rate=fee_rate)

            context["result"] = recommendation
            context["graph_ocr"] = graph_text
            context["hdv_ocr"] = hdv_text
        except Exception as exc:  # noqa: BLE001
            context["error"] = str(exc)

    return render_template("index.html", **context)


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8000, debug=True)
