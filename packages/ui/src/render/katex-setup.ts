/**
 * KaTeX as the transcript uses it: every environment KaTeX has (align, gather, cases, matrices,
 * pmatrix/bmatrix...), chemistry through mhchem (\ce, \pu), and the physics notation models reach
 * for, as macros (bra-ket, vectors, derivatives, units). Always with trust: false, so no command can
 * emit a URL or raw HTML.
 */

// mhchem extends KaTeX in place (\ce, \pu); it must load after katex itself, which this import order ensures.
import 'katex';
import 'katex/contrib/mhchem';

export const KATEX_MACROS: Record<string, string> = {
  // Quantum: bra-ket.
  '\\bra': '\\left\\langle #1\\right|',
  '\\ket': '\\left|#1\\right\\rangle',
  '\\braket': '\\left\\langle #1\\middle|#2\\right\\rangle',
  '\\expval': '\\left\\langle #1\\right\\rangle',
  // Vectors and operators.
  '\\vb': '\\mathbf{#1}',
  '\\vu': '\\hat{\\mathbf{#1}}',
  '\\grad': '\\nabla',
  '\\curl': '\\nabla\\times',
  '\\divergence': '\\nabla\\cdot',
  '\\abs': '\\left|#1\\right|',
  '\\norm': '\\left\\|#1\\right\\|',
  // Derivatives.
  '\\dv': '\\frac{\\mathrm{d}#1}{\\mathrm{d}#2}',
  '\\pdv': '\\frac{\\partial#1}{\\partial#2}',
  '\\deriv': '\\frac{d#1}{d#2}',
  '\\pderiv': '\\frac{\\partial#1}{\\partial#2}',
  '\\dd': '\\,\\mathrm{d}',
  // Units, siunitx-like: \SI{9.81}{m/s^2}, \si{kg}, \qty{3}{\meter}.
  '\\SI': '#1\\,\\mathrm{#2}',
  '\\si': '\\mathrm{#1}',
  '\\qty': '#1\\,\\mathrm{#2}',
  '\\unit': '\\mathrm{#1}',
  '\\num': '#1',
  '\\degree': '^{\\circ}',
  '\\celsius': '^{\\circ}\\mathrm{C}',
  '\\RR': '\\mathbb{R}', '\\NN': '\\mathbb{N}', '\\ZZ': '\\mathbb{Z}', '\\CC': '\\mathbb{C}', '\\QQ': '\\mathbb{Q}',
};

export const KATEX_OPTIONS = { throwOnError: false, strict: false, trust: false, output: 'html' as const, macros: KATEX_MACROS };
