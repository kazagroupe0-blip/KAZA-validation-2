      }

      // La conversation est ensuite utilisée comme un vrai échange.
      await tenant.getByLabel('Message').fill(tenantMessage);
      await tenant.getByRole('button', { name: 'Envoyer' }).click();
      await expect(
        tenant.getByTestId('chat-thread').getByText(tenantMessage, { exact: true }),
      ).toBeVisible();

      // Le bailleur voit la même conversation via sa propre session.
      await login(landlord, LANDLORD_EMAIL, LANDLORD_PW);
      await landlord.goto('/chat');
      await expect(landlord.getByTestId('conversation-list')).toBeVisible({ timeout: 15_000 });