-- =============================================================================
-- SEED 004: VERIFIED CUSTOMER FAQS (31 QUESTIONS)
-- Sources: index.html (#trust - 19) + 3 SEO Landing Pages (4 each = 12)
-- =============================================================================

BEGIN;

INSERT INTO faqs (faq_number, category, question, answer, source_page, section_anchor, display_order, is_active) VALUES
(1, 'concierge_faq', '1. How do I place an order?', 'Simply choose your favourite press-on design and click Order on WhatsApp. We''ll guide you through the entire process, confirm your order, discuss any customizations if needed, and begin crafting your set once everything is finalized.', 'index.html', '#trust', 1, TRUE),
(2, 'concierge_faq', '2. How long will it take to receive my order?', 'Every press-on set is handmade after your order is confirmed. Delivery time depends on your location and the complexity of the design. We''ll share the estimated delivery timeline before we begin crafting your order.', 'index.html', '#trust', 2, TRUE),
(3, 'concierge_faq', '3. Can I request a custom nail design?', 'Absolutely! If you have a reference image or your own design idea, we''d love to create a custom set that matches your vision.', 'index.html', '#trust', 3, TRUE),
(4, 'concierge_faq', '4. Can I customise an existing press-on design?', 'Yes! If you love one of our existing designs but would like a different colour, finish, length, shape, or a few personal touches, we can customise it just for you. Every set is handcrafted after your order is confirmed, making it easy to create something that''s uniquely yours.', 'index.html', '#trust', 4, TRUE),
(5, 'concierge_faq', '5. Are your press-on nails handmade?', 'Yes. Every Nails by Divya press-on set is handcrafted only after your order is confirmed. We never sell factory-made or mass-produced nail sets.', 'index.html', '#trust', 5, TRUE),
(6, 'concierge_faq', '6. Can I reuse my press-on nails?', 'Yes! With proper application, gentle removal and good care, your press-on nails can be reused multiple times.', 'index.html', '#trust', 6, TRUE),
(7, 'concierge_faq', '7. Do you provide at-home nail appointments?', 'Yes. We offer professional at-home nail appointments across selected areas of Delhi NCR. Simply book an appointment through the website or contact us on WhatsApp.', 'index.html', '#trust', 7, TRUE),
(8, 'concierge_faq', '8. Do you also take event bookings?', 'Yes! We''re available for bridal events, private parties, corporate events, brand activations, influencer collaborations, photoshoots and other special occasions. Contact us with your event details and we''ll discuss the best arrangement.', 'index.html', '#trust', 8, TRUE),
(9, 'concierge_faq', '9. What if my order arrives damaged during delivery?', 'If your order arrives damaged during transit, contact us within 24 hours of receiving it and share clear photos of the damage. We''ll review the issue and work with you to find the best possible solution.', 'index.html', '#trust', 9, TRUE),
(10, 'concierge_faq', '10. Can I cancel or change my order?', 'Since every press-on set is handcrafted after confirmation, changes or cancellations are only possible before production begins. Please contact us as soon as possible if you need assistance.', 'index.html', '#trust', 10, TRUE),
(11, 'concierge_faq', '11. Do you deliver across India?', 'Yes! We deliver our handmade press-on nail sets across India. Delivery timelines may vary depending on your location.', 'index.html', '#trust', 11, TRUE),
(12, 'concierge_faq', '12. What comes with my press-on nail order?', 'Every order includes your handmade press-on nail set along with the essential application accessories and easy-to-follow instructions, so you can apply your nails confidently at home.', 'index.html', '#trust', 12, TRUE),
(13, 'concierge_faq', '13. What if I''m unsure about my nail size?', 'Don''t worry! We''ll guide you through a simple sizing process before confirming your order, helping you choose the best fit with confidence.', 'index.html', '#trust', 13, TRUE),
(14, 'concierge_faq', '14. How should I care for my press-on nails?', 'Avoid excessive exposure to water immediately after application, remove them gently and store them safely after use. With proper care, your handmade press-on nails can be reused multiple times.', 'index.html', '#trust', 14, TRUE),
(15, 'concierge_faq', '15. What are the benefits of referring Nails by Divya to your friends and family?', 'We truly appreciate every recommendation. From time to time, we offer exclusive referral rewards, special discounts and surprise offers for customers who refer their friends and family. Follow us on Instagram or chat with us to stay updated on the latest referral benefits.', 'index.html', '#trust', 15, TRUE),
(16, 'concierge_faq', '16. What if I''m unavailable when my order is delivered?', 'If you''re unavailable during delivery, the courier may attempt another delivery or contact you to arrange a convenient time. If you already know you''ll be unavailable, let us know in advance and we''ll do our best to help coordinate your delivery.', 'index.html', '#trust', 16, TRUE),
(17, 'concierge_faq', '17. How are the delivery charges calculated?', 'Delivery charges are calculated based on your delivery location. To ensure your order reaches you safely and securely, delivery charges are kept separate from the product price. Our team will confirm the exact delivery charge based on your location before your order is finalized.', 'index.html', '#trust', 17, TRUE),
(18, 'concierge_faq', '19. Which areas do you cover for home nail services?', 'Our at-home nail services are available across selected areas of Delhi NCR, including Delhi, Gurgaon, Noida, South Delhi, Central Delhi and Aerocity. Share your location with us before booking and we''ll confirm availability.', 'index.html', '#trust', 18, TRUE),
(19, 'concierge_faq', '18. Still have a question?', 'We''d love to help.
                      Whether you need advice on sizing, choosing the perfect design, booking a home appointment, planning an event or creating something completely custom, we''re just one message away.
                      
                        💬 Chat with the Artist', 'index.html', '#trust', 19, TRUE),
(20, 'press_on_faq', 'Are Nails by Divya press-on nails handmade?', 'Yes. Each press-on set is handcrafted after your order is confirmed rather than mass-produced as a ready-made stock set.', 'press-on-nails-india.html', '#faq', 1, TRUE),
(21, 'press_on_faq', 'Do you deliver press-on nails across India?', 'Yes. Handmade press-on sets are available for delivery across India. Exact delivery timing and charges depend on the destination.', 'press-on-nails-india.html', '#faq', 2, TRUE),
(22, 'press_on_faq', 'Can I customise a press-on design?', 'Yes. You can share an inspiration image or ask about changes to an existing collection design. Final design and pricing are confirmed before production.', 'press-on-nails-india.html', '#faq', 3, TRUE),
(23, 'press_on_faq', 'How do I know my press-on size?', 'We guide you through the sizing process before confirming the order.', 'press-on-nails-india.html', '#faq', 4, TRUE),
(24, 'at_home_service_faq', 'Do you offer nail extensions at home?', 'Yes. Nails by Divya offers at-home nail appointments across selected Delhi NCR areas.', 'nail-extensions.html', '#faq', 1, TRUE),
(25, 'at_home_service_faq', 'Can I choose my nail shape and length?', 'Yes. Your preferred shape, length, colour and design direction are discussed before the service.', 'nail-extensions.html', '#faq', 2, TRUE),
(26, 'at_home_service_faq', 'Do you do nail art with extensions?', 'Yes. Custom French, chrome, floral, 3D and other nail-art styles can be discussed for your appointment.', 'nail-extensions.html', '#faq', 3, TRUE),
(27, 'at_home_service_faq', 'How do I book?', 'Use the WhatsApp booking button or the appointment section on the main website to start an enquiry.', 'nail-extensions.html', '#faq', 4, TRUE),
(28, 'custom_nail_art_faq', 'Can I bring my own nail-art reference?', 'Yes. Share your inspiration and we''ll discuss what can be created and any design-specific pricing before confirmation.', 'nail-art.html', '#faq', 1, TRUE),
(29, 'custom_nail_art_faq', 'Can nail art be done with extensions?', 'Yes. Custom nail art can be discussed for extension appointments as well as natural nails and other services.', 'nail-art.html', '#faq', 2, TRUE),
(30, 'custom_nail_art_faq', 'Do you offer French nails?', 'Yes. Classic and customised French nail designs are part of the service range.', 'nail-art.html', '#faq', 3, TRUE),
(31, 'custom_nail_art_faq', 'Can you match nails to an outfit or event?', 'Yes. Outfit, wedding, festival, party and personal-theme inspiration can all be part of the design conversation.', 'nail-art.html', '#faq', 4, TRUE)
ON CONFLICT (faq_number) DO NOTHING;

COMMIT;
