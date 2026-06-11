-- =====================================================================
-- Blink Server — Seed per-role mock notifications (dev/testing)
-- =====================================================================
-- Mirrors the mobile app's per-role mock arrays (data/*-notifications-mock.ts)
-- so the wired notification screens render real content immediately. Seeds each
-- existing user with their role's notifications, but only if that user has none
-- yet — re-running (db reset) won't duplicate. `payload` JSONB matches the
-- app's AppNotification.payload shape ({ offer | benefit | deposit | news }).

-- ─── Customers ───────────────────────────────────────────────────────
INSERT INTO notifications (user_id, type, title, description, is_unread, href, payload, created_at)
SELECT u.id, v.type::notification_type, v.title, v.description, v.is_unread, v.href, v.payload, now() - v.age
FROM users u
CROSS JOIN (VALUES
  ('offer', 'Weekend Surge Bonus!', 'Complete 25 trips this weekend to earn an extra 3,000 DZD bonus.', true, NULL,
    '{"offer":{"statusLabel":"ACTIVE CHALLENGE","endsAtLabel":"Ends Oct 31, 23:59","rewardLabel":"Potential Reward","rewardAmount":"2,500 DZD","goalLabel":"Goal & Rules","goalText":"Complete 25 trips this weekend to earn an extra 3,000 DZD.","progressLabel":"Your Progress","progressCurrent":15,"progressTarget":25,"offerType":"courier","ctaLabel":"Go to Challenges","ctaHref":"/(customer)/promos"}}'::jsonb, interval '2 hours'),
  ('promo', 'Grab your 50% discount!', 'Click here to see your personalized list of marketplace discounts.', true, '/(customer)/promos', NULL, interval '10 minutes'),
  ('courier', 'Courier on the way!', 'Your rider is picking up your parcel and will be arriving at the destination soon.', true, NULL, NULL, interval '15 minutes'),
  ('order', 'Order Delivered', 'Success! Your order from ''The Fresh Market'' has been delivered. Rate your experience.', false, NULL, NULL, interval '1 day'),
  ('security', 'New Login Detected', 'A new login was detected from a Chrome browser on Windows in Algiers.', false, NULL, NULL, interval '1 day')
) AS v(type, title, description, is_unread, href, payload, age)
WHERE u.role = 'customer'
  AND NOT EXISTS (SELECT 1 FROM notifications n WHERE n.user_id = u.id);

-- ─── Riders ──────────────────────────────────────────────────────────
INSERT INTO notifications (user_id, type, title, description, is_unread, href, payload, created_at)
SELECT u.id, v.type::notification_type, v.title, v.description, v.is_unread, v.href, v.payload, now() - v.age
FROM users u
CROSS JOIN (VALUES
  ('alert', 'Suspicious Activity', 'A recent trip associated with your account has been flagged for review', true, NULL, NULL, interval '2 minutes'),
  ('offer', 'Weekend Surge Bonus!', 'Complete 25 trips this weekend to earn an extra 3,000 DZD.', true, '/(rider)/notifications/offers/surge-1',
    '{"offer":{"statusLabel":"ACTIVE CHALLENGE","endsAtLabel":"Ends Oct 31, 23:59","rewardLabel":"POTENTIAL REWARD","rewardAmount":"2,500 DZD","goalLabel":"Goal & Rules","goalText":"Complete 25 trips this weekend to earn an extra 3,000 DZD. Cancelled orders do not count.","progressLabel":"Your Progress","progressCurrent":15,"progressTarget":25,"cancellationRateLimit":10,"cancellationRateCurrent":4,"ctaLabel":"Go to Challenges"}}'::jsonb, interval '5 hours'),
  ('benefit', '15% Off Spare Parts at AutoPro', 'Exclusive discount on all mechanical spare parts for Blink Riders.', true, '/(rider)/notifications/benefits/autopro-1',
    '{"benefit":{"category":"MAINTENANCE","validUntil":"31 Dec 2025","aboutText":"Blink Riders get an exclusive 15% discount on all mechanical spare parts at any AutoPro branch across Algiers and Oran.","redeemSteps":["Visit any AutoPro branch during business hours.","Present your Blink Rider ID profile from the app.","The discount will be applied directly to your invoice."],"terms":["Discount applies to spare parts only, labor costs are excluded.","Cannot be combined with other ongoing promotions.","Valid for active Blink Riders with a rating above 4.5."],"phoneNumber":"+213000000000","location":"AutoPro Algiers"}}'::jsonb, interval '1 day'),
  ('deposit', 'Get 3,000 DZD Bonus', 'Unlock your reward instantly by topping up your Blink Wallet.', false, '/(rider)/notifications/bonuses/deposit-1',
    '{"deposit":{"bonusAmount":"3,000 DZD","conditionText":"Top up your Blink Wallet with a minimum of 5,000 DZD. The bonus is applied directly to your ride balance.","instantCredit":true,"exclusiveAccess":true,"validForDays":"7","terms":["Bonus credit is non-refundable and can only be used for ride bookings.","Valid for a single transaction per user.","Bonus balance expires 7 days after deposit if not utilized."],"ctaLabel":"Apply Offer & Deposit"}}'::jsonb, interval '2 days')
) AS v(type, title, description, is_unread, href, payload, age)
WHERE u.role = 'rider'
  AND NOT EXISTS (SELECT 1 FROM notifications n WHERE n.user_id = u.id);

-- ─── Agents ──────────────────────────────────────────────────────────
INSERT INTO notifications (user_id, type, title, description, is_unread, href, payload, created_at)
SELECT u.id, v.type::notification_type, v.title, v.description, v.is_unread, v.href, v.payload, now() - v.age
FROM users u
CROSS JOIN (VALUES
  ('alert', 'Required actions', 'A recent operation associated with your account requires your attention.', true, NULL, NULL, interval '2 minutes'),
  ('offer', 'Agent Bonus: Top Recruiter', 'Recruit 5 new riders this month and earn a 5,000 DZD bonus directly to your wallet.', true, '/(agent)/notifications/offers/agent-offer-2',
    '{"offer":{"statusLabel":"SPECIAL OFFER","endsAtLabel":"Ends Oct 31, 23:59","rewardLabel":"POTENTIAL REWARD","rewardAmount":"5,000 DZD","goalLabel":"Goal & Rules","goalText":"Successfully onboard 5 new verified riders before end of month.","progressLabel":"Your Progress","progressCurrent":2,"progressTarget":5,"ctaLabel":"View Details"}}'::jsonb, interval '6 hours'),
  ('deposit', 'Get 3,000 DZD Bonus', 'Unlock your reward instantly by topping up your Blink Wallet.', false, '/(agent)/notifications/bonuses/agent-deposit-1',
    '{"deposit":{"bonusAmount":"3,000 DZD","conditionText":"Top up your Blink Wallet with a minimum of 5,000 DZD.","instantCredit":true,"exclusiveAccess":true,"validForDays":"7","terms":["Bonus credit is non-refundable.","Valid for a single transaction per user."],"ctaLabel":"Apply Offer & Deposit"}}'::jsonb, interval '2 days'),
  ('benefit', '15% Off Spare Parts at AutoPro', 'Exclusive discount on all mechanical spare parts for Blink Agents.', false, '/(agent)/notifications/benefits/agent-benefit-1',
    '{"benefit":{"category":"MAINTENANCE","validUntil":"31 Dec 2025","aboutText":"Blink Agents get an exclusive 15% discount on all mechanical spare parts at any AutoPro branch.","redeemSteps":["Visit any AutoPro branch during business hours.","Present your Blink Agent ID profile from the app."],"terms":["Discount applies to spare parts only.","Cannot be combined with other promotions."],"phoneNumber":"+213000000000","location":"AutoPro Algiers"}}'::jsonb, interval '3 days')
) AS v(type, title, description, is_unread, href, payload, age)
WHERE u.role = 'agent'
  AND NOT EXISTS (SELECT 1 FROM notifications n WHERE n.user_id = u.id);

-- ─── Merchants ───────────────────────────────────────────────────────
INSERT INTO notifications (user_id, type, title, description, is_unread, href, payload, created_at)
SELECT u.id, v.type::notification_type, v.title, v.description, v.is_unread, v.href, v.payload, now() - v.age
FROM users u
CROSS JOIN (VALUES
  ('alert', 'Required Actions', 'Your commercial register (back) image needs re-upload — please provide a clearer photo.', true, NULL, NULL, interval '2 minutes'),
  ('alert', 'Dues Reminder', 'Your monthly dues to Blink are due in 3 days. Pay now to avoid late fees.', true, NULL, NULL, interval '1 hour'),
  ('offer', 'Lower Commissions Challenge', 'Achieve 100 sales this month and unlock a 1.5% commission reduction for next quarter.', true, '/(merchant)/notifications/offers/merchant-offer-1',
    '{"offer":{"statusLabel":"ACTIVE CHALLENGE","endsAtLabel":"Ends Oct 31, 23:59","rewardLabel":"POTENTIAL REWARD","rewardAmount":"1.5% commission cut","goalLabel":"Goal & Rules","goalText":"Reach 100 completed sales this month across all your stores.","progressLabel":"Your Progress","progressCurrent":62,"progressTarget":100,"ctaLabel":"Go to Challenges"}}'::jsonb, interval '8 hours'),
  ('benefit', '20% Off Packaging Supplies at PackPro', 'Exclusive discount for Blink merchants on packaging, bags, and protective materials.', false, '/(merchant)/notifications/benefits/merchant-benefit-1',
    '{"benefit":{"category":"SUPPLIES","validUntil":"31 Dec 2026","aboutText":"Blink merchants get 20% off packaging supplies at any PackPro branch.","redeemSteps":["Visit any PackPro branch during business hours.","Present your Blink Merchant profile from the app."],"terms":["Discount applies to packaging materials only.","Cannot be combined with other promotions."],"phoneNumber":"+213000000000","location":"PackPro Algiers"}}'::jsonb, interval '1 day'),
  ('deposit', 'Pay Dues Now, Get 5% Back', 'Settle this month''s dues in the next 48 hours and receive 5% back as Blink Cash credit.', false, '/(merchant)/notifications/bonuses/merchant-deposit-1',
    '{"deposit":{"bonusAmount":"5% of dues paid","conditionText":"Pay your full outstanding dues within 48 hours and receive 5% back as Blink Cash credit.","instantCredit":true,"exclusiveAccess":false,"validForDays":"2","terms":["Credit is non-refundable and only usable inside the Blink Merchant app.","Offer applies once per merchant per month."],"ctaLabel":"Pay Dues Now"}}'::jsonb, interval '2 days')
) AS v(type, title, description, is_unread, href, payload, age)
WHERE u.role = 'merchant'
  AND NOT EXISTS (SELECT 1 FROM notifications n WHERE n.user_id = u.id);

-- ─── Normalize typed-notification hrefs to the real row id ───────────
-- The VALUES above used placeholder slug ids for readability. Detail screens
-- (and a tapped push) resolve a notification by its actual id, so rewrite each
-- typed href to its detail page using the generated row id + recipient role.
-- Mirrors src/lib/notifications.ts detailHref() / the app's notification-nav.
UPDATE notifications n
SET href = CASE n.type
  WHEN 'offer'    THEN '/(' || u.role || ')/notifications/offers/'   || n.id
  WHEN 'benefit'  THEN '/(' || u.role || ')/notifications/benefits/' || n.id
  WHEN 'deposit'  THEN '/(' || u.role || ')/notifications/bonuses/'  || n.id
  WHEN 'alert'    THEN '/(' || u.role || ')/notifications/'          || n.id
  WHEN 'security' THEN '/(' || u.role || ')/notifications/'          || n.id
  ELSE n.href
END
FROM users u
WHERE u.id = n.user_id
  AND n.type IN ('offer', 'benefit', 'deposit', 'alert', 'security');
