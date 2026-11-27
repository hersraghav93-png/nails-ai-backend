"use strict";

// Owner-approved presentation for these SKUs. Commercial data still comes from the catalogue.
const approvedDesigns = {
  "CAS-004": {
    "imageUrl": "assets/portfolio/nvm8.png",
    "description": "A deep red set with a glossy, light-catching finish."
  },
  "PAR-008": {
    "imageUrl": "assets/studio/ruby-540.webp",
    "description": "Rich ruby red with a smooth, glossy finish."
  },
  "PAR-009": {
    "imageUrl": "assets/portfolio/newnail2.png",
    "description": "Deep blue with reflective flecks that catch the light."
  },
  "WED-001": {
    "imageUrl": "assets/portfolio/nail6.png",
    "description": "Soft milky tones with blue floral accents."
  },
  "WED-002": {
    "imageUrl": "assets/portfolio/dv1.jpeg",
    "description": "A warm metallic finish with a mirror-like shine."
  },
  "WED-007": {
    "imageUrl": "assets/portfolio/port61.jpeg",
    "description": "Pale blue and white with an intricate repeating pattern."
  }
};

function getApprovedDesign(sku) {
  return Object.hasOwn(approvedDesigns, sku) ? approvedDesigns[sku] : null;
}

module.exports = { getApprovedDesign };
