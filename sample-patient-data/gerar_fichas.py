"""Gera fichas de pacientes (2 PDFs + 1 TXT) para uso como fonte de dados do CRM odontológico."""

from reportlab.lib.pagesizes import A4
from reportlab.lib.units import cm
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.enums import TA_LEFT
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle
from reportlab.lib import colors
import os

BASE = os.path.dirname(os.path.abspath(__file__))


def build_pdf(filename, paciente, secoes):
    doc = SimpleDocTemplate(
        os.path.join(BASE, filename),
        pagesize=A4,
        topMargin=2 * cm,
        bottomMargin=2 * cm,
        leftMargin=2 * cm,
        rightMargin=2 * cm,
    )
    styles = getSampleStyleSheet()
    titulo = ParagraphStyle("Titulo", parent=styles["Title"], fontSize=18, spaceAfter=4)
    sub = ParagraphStyle("Sub", parent=styles["Normal"], fontSize=10, textColor=colors.grey, spaceAfter=14)
    h2 = ParagraphStyle("H2", parent=styles["Heading2"], fontSize=12, textColor=colors.HexColor("#1565c0"), spaceBefore=10, spaceAfter=4)
    body = ParagraphStyle("Body", parent=styles["Normal"], fontSize=10, leading=15, alignment=TA_LEFT)

    elems = [
        Paragraph("Clínica IntelliDental", titulo),
        Paragraph("Ficha de Cadastro e Anamnese do Paciente", sub),
    ]

    # Tabela de dados cadastrais
    dados = [[Paragraph(f"<b>{k}</b>", body), Paragraph(v, body)] for k, v in paciente.items()]
    tbl = Table(dados, colWidths=[5 * cm, 11.5 * cm])
    tbl.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LINEBELOW", (0, 0), (-1, -1), 0.25, colors.HexColor("#e0e0e0")),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
    ]))
    elems.append(tbl)
    elems.append(Spacer(1, 8))

    for titulo_secao, conteudo in secoes:
        elems.append(Paragraph(titulo_secao, h2))
        elems.append(Paragraph(conteudo, body))

    doc.build(elems)
    print("gerado:", filename)


# ---------------------------------------------------------------------------
# Paciente 1 (PDF)
# ---------------------------------------------------------------------------
build_pdf(
    "ficha-mariana-oliveira.pdf",
    {
        "Nome completo": "Mariana Souza de Oliveira",
        "Data de nascimento": "14/03/1990 (36 anos)",
        "CPF": "327.845.910-22",
        "Telefone / WhatsApp": "(11) 98432-7711",
        "E-mail": "mariana.oliveira@email.com",
        "Endereço": "Rua das Acácias, 142 - Vila Madalena, São Paulo/SP",
        "Convênio": "Particular",
        "Primeira consulta": "08/02/2026",
    },
    [
        ("Queixa principal",
         "Paciente relata sensibilidade ao consumir alimentos gelados no dente superior direito "
         "e sangramento gengival ao escovar há cerca de três semanas."),
        ("Histórico médico",
         "Sem doenças crônicas. Não faz uso contínuo de medicamentos. Alergia relatada a "
         "<b>penicilina</b>. Não fumante. Nega diabetes e hipertensão."),
        ("Histórico odontológico",
         "Última limpeza há 14 meses. Possui duas restaurações em resina nos molares inferiores. "
         "Nunca realizou tratamento de canal. Usa fio dental ocasionalmente."),
        ("Plano de tratamento sugerido",
         "Profilaxia completa, aplicação de flúor e avaliação de gengivite. Reavaliar sensibilidade "
         "após raspagem supragengival. Retorno em 7 dias."),
        ("Observações",
         "Prefere atendimento no período da tarde. Demonstra ansiedade em procedimentos longos."),
    ],
)

# ---------------------------------------------------------------------------
# Paciente 2 (PDF)
# ---------------------------------------------------------------------------
build_pdf(
    "ficha-carlos-mendes.pdf",
    {
        "Nome completo": "Carlos Eduardo Mendes",
        "Data de nascimento": "27/09/1978 (47 anos)",
        "CPF": "118.402.665-09",
        "Telefone / WhatsApp": "(21) 99117-3322",
        "E-mail": "carlos.mendes@email.com",
        "Endereço": "Av. Atlântica, 980 - Copacabana, Rio de Janeiro/RJ",
        "Convênio": "OdontoPrev (carteirinha 4471-8890)",
        "Primeira consulta": "21/01/2026",
    },
    [
        ("Queixa principal",
         "Dor latejante no dente inferior esquerdo (molar) que piora à noite. Relata dificuldade "
         "para mastigar do lado afetado há cinco dias."),
        ("Histórico médico",
         "<b>Hipertenso</b> controlado com losartana 50mg/dia. Pré-diabético em acompanhamento. "
         "Ex-fumante (parou há 6 anos). Sem alergias medicamentosas conhecidas."),
        ("Histórico odontológico",
         "Possui prótese fixa (coroa) no dente 26. Já realizou dois tratamentos de canal. "
         "Bruxismo diagnosticado, faz uso de placa de mordida noturna."),
        ("Plano de tratamento sugerido",
         "Radiografia periapical do molar inferior esquerdo. Suspeita de pulpite irreversível com "
         "possível indicação de endodontia. Prescrição de analgésico e antibiótico se houver abscesso."),
        ("Observações",
         "Verificar pressão arterial antes de procedimentos com anestésico vasoconstritor. "
         "Paciente pontual, prefere agendamentos no início da manhã."),
    ],
)

print("PDFs concluídos.")
