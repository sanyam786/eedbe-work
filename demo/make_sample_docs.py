"""Generates sample client documents that look like portal downloads, for demos and tests.

    python3 demo/make_sample_docs.py demo/documents   (then upload the folder in the dashboard)

Requires: pip install reportlab   (and qpdf for the locked files)
"""
import os
import subprocess
import sys

from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas


def pdf(path, lines, scanned=False):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    c = canvas.Canvas(path, pagesize=A4)
    if scanned:  # image-like page with no text layer
        for i in range(12):
            c.rect(60, 760 - i * 50, 470, 30, fill=1)
    else:
        y = 800
        for line in lines:
            c.drawString(50, y, line)
            y -= 18
    c.save()


def lock(path, password):
    tmp = path + ".tmp"
    subprocess.run(["qpdf", "--encrypt", password, "owner-" + password, "256", "--", path, tmp], check=True)
    os.replace(tmp, path)


def itrv(name, pan, ay, form="ITR-1 (SAHAJ)"):
    return [
        "INDIAN INCOME TAX RETURN ACKNOWLEDGEMENT",
        f"[Where the data of the Return of Income in Form {form} transmitted electronically]",
        f"Assessment Year {ay}",
        f"PAN {pan}",
        f"Name {name.upper()}",
        "Total Income 12,45,300",
        "Acknowledgement Number 123456789012345",
    ]


def computation(name, pan, ay, py):
    return [
        "COMPUTATION OF TOTAL INCOME",
        f"Name: {name.upper()}    PAN: {pan}",
        f"Assessment Year: {ay}    Previous Year: {py}",
        "Income from Salary 9,80,000",
        "Income from Other Sources 45,300",
    ]


def gstr3b(gstin, legal, year, period):
    return [
        "Form GSTR-3B",
        "[See rule 61(5)]",
        f"Year {year}",
        f"Period {period}",
        f"1. GSTIN {gstin}",
        f"2(a). Legal name of the registered person {legal}",
        "3.1 Details of Outward supplies and inward supplies liable to reverse charge",
    ]


def main(root):
    R = lambda *p: os.path.join(root, *p)

    # Ramesh Sharma (individual)
    pdf(R("Ramesh Sharma", "ITR", "AY 2025-26", "ITR-V.pdf"), itrv("Ramesh Sharma", "ABCPS1234K", "2025-26"))
    pdf(R("Ramesh Sharma", "ITR", "AY 2025-26", "Computation.pdf"),
        computation("Ramesh Sharma", "ABCPS1234K", "2025-26", "2024-25"))
    p = R("Ramesh Sharma", "ITR", "AY 2024-25", "ITRV_ABCPS1234K.pdf")  # locked by the portal
    pdf(p, itrv("Ramesh Sharma", "ABCPS1234K", "2024-25"))
    lock(p, "abcps1234k15081975")
    pdf(R("Ramesh Sharma", "ITR", "AY 2023-24", "Acknowledgement.pdf"), itrv("Ramesh Sharma", "ABCPS1234K", "2023-24"))
    pdf(R("Ramesh Sharma", "Form 16", "2024-25", "Form16.pdf"), [
        "FORM NO. 16", "[See rule 31(1)(a)]", "PART A",
        "Certificate under section 203 of the Income-tax Act, 1961 for tax deducted at source on salary",
        "PAN of the Deductor AAACI1234F", "PAN of the Employee ABCPS1234K", "Assessment Year 2025-26"])
    p = R("Ramesh Sharma", "26AS", "26AS_2024-25.pdf")  # 26AS is locked with DOB only
    pdf(p, ["Annual Tax Statement", "Form 26AS", "Permanent Account Number (PAN) ABCPS1234K",
            "Financial Year 2024-25", "Assessment Year 2025-26"])
    lock(p, "15081975")

    # Sharma Traders (firm, two GSTINs)
    pdf(R("Sharma Traders", "ITR", "AY 2025-26", "ITR-V.pdf"),
        itrv("Sharma Traders", "AAHFS5678L", "2025-26", "ITR-5") + ["Verified by partner ABCPS1234K"])
    for fy, month in [("2025-26", "March"), ("2026-27", "April"), ("2026-27", "May"), ("2026-27", "June"),
                      ("2026-27", "August")]:
        pdf(R("Sharma Traders", "GST", fy, f"GSTR3B_{month[:3]}.pdf"),
            gstr3b("08AAHFS5678L1Z3", "SHARMA TRADERS", fy, month))
    pdf(R("Sharma Traders", "GST", "2026-27", "GSTR1_Aug.pdf"), [
        "Form GSTR-1", "Details of outward supplies of goods or services",
        "Financial Year 2026-27", "Tax Period August",
        "1. GSTIN 08AAHFS5678L1Z3", "2(a). Legal name SHARMA TRADERS",
        "4A B2B Invoices", "Recipient GSTIN 08AABCM4321Q1ZP  Invoice 1045  Value 1,20,000"])
    pdf(R("Sharma Traders Gujarat", "GST", "GSTR-3B Aug 2026.pdf"),
        gstr3b("24AAHFS5678L1Z9", "SHARMA TRADERS", "2026-27", "August"))

    # Mehta Enterprises (company)
    pdf(R("Mehta Enterprises", "GST", "GSTR-9 FY 2024-25.pdf"),
        ["FORM GSTR-9", "Annual Return", "Financial Year 2024-25", "GSTIN 08AABCM4321Q1ZP",
         "Legal Name MEHTA ENTERPRISES PRIVATE LIMITED"])
    pdf(R("Mehta Enterprises", "GST", "REG-06.pdf"),
        ["Government of India", "Form GST REG-06", "Registration Certificate",
         "Registration Number: 08AABCM4321Q1ZP", "Legal Name MEHTA ENTERPRISES PRIVATE LIMITED"])
    # A scanned return: no text, so the folder and file names are all the indexer has
    pdf(R("Mehta Enterprises", "GST", "2026-27", "August", "GSTR3B.pdf"), [], scanned=True)

    # Mehta Family HUF (needs staff approval)
    pdf(R("Mehta Family HUF", "ITR-V AY 2025-26.pdf"), itrv("Mehta Family HUF", "AAGHM1122H", "2025-26", "ITR-2"))

    # Files the indexer can't place -> review queue
    pdf(R("Misc", "ITR-V.pdf"), itrv("Unknown Person", "ZZZPZ9999Z", "2025-26"))
    pdf(R("Misc", "scan0042.pdf"), [], scanned=True)


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "demo/documents")
