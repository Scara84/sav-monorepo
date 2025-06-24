// Export the mock supabase client for testing
export const supabase = {
  // Mock any methods used in WebhookItemsList.vue
  // Add any necessary mock implementations here
  storage: {
    from: () => ({
      upload: () => Promise.resolve({ data: { Key: 'mocked-file-path.jpg' }, error: null })
    })
  }
};

export default supabase;
